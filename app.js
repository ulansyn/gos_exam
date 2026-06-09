/**
 * ExamPrep AI - Компьютерная инженерия: подготовка к госэкзамену
 * Основная логика приложения и роутер
 */

// ==========================================================================
// УПРАВЛЕНИЕ СОСТОЯНИЕМ И ЛОКАЛЬНОЕ ХРАНИЛИЩЕ
// ==========================================================================
const DEFAULT_STATE = {
  activeView: 'dashboard',
  currentTopicId: 'stack',
  currentCardIndex: 0,
  flashcardFlipped: false,
  cardFilter: 'all',
  dbLang: 'kg',      // Язык базы данных: 'kg' (Кыргызский) или 'ru' (Русский)
  apiKey: 'sk-7e19128a33c5497eb38ccb3f2b36e0d5',
  aiEngine: 'deepseek',
  currentTopicTab: 'theory',
  currentTopicCardIndex: 0,
  progress: {
    topicScores: {}, // { topicId: maxScore }
    cardStates: {},  // { termKey: 'know'|'repeat'|'hard' }
    examHistory: []  // Массив объектов { date, score, grade, totalQuestions }
  },
  activeExam: null   // Текущая сессия экзамена
};

let state = { ...DEFAULT_STATE };

// Загрузка состояния из localStorage
function loadState() {
  const saved = localStorage.getItem('examprep_state');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      state.progress = { ...DEFAULT_STATE.progress, ...parsed.progress };
      state.currentTopicId = parsed.currentTopicId || DEFAULT_STATE.currentTopicId;
      state.cardFilter = parsed.cardFilter || DEFAULT_STATE.cardFilter;
      state.dbLang = parsed.dbLang || DEFAULT_STATE.dbLang;
      state.apiKey = parsed.apiKey !== undefined ? parsed.apiKey : DEFAULT_STATE.apiKey;
      state.aiEngine = parsed.aiEngine || DEFAULT_STATE.aiEngine;
      state.currentTopicTab = parsed.currentTopicTab || DEFAULT_STATE.currentTopicTab;
      state.currentTopicCardIndex = parsed.currentTopicCardIndex !== undefined ? parsed.currentTopicCardIndex : DEFAULT_STATE.currentTopicCardIndex;
    } catch (e) {
      console.error('Ошибка загрузки состояния из localStorage:', e);
    }
  } else {
    state.apiKey = DEFAULT_STATE.apiKey;
    state.aiEngine = DEFAULT_STATE.aiEngine;
    state.currentTopicTab = DEFAULT_STATE.currentTopicTab;
    state.currentTopicCardIndex = DEFAULT_STATE.currentTopicCardIndex;
  }
}

// Сохранение состояния в localStorage
function saveState() {
  localStorage.setItem('examprep_state', JSON.stringify({
    progress: state.progress,
    currentTopicId: state.currentTopicId,
    cardFilter: state.cardFilter,
    dbLang: state.dbLang,
    apiKey: state.apiKey,
    aiEngine: state.aiEngine,
    currentTopicTab: state.currentTopicTab,
    currentTopicCardIndex: state.currentTopicCardIndex
  }));
  updateGlobalProgressUI();
}

// Сброс прогресса
function resetProgress() {
  if (confirm('Вы действительно хотите сбросить весь прогресс и статистику тренировок?')) {
    state.progress = {
      topicScores: {},
      cardStates: {},
      examHistory: []
    };
    state.currentTopicTab = 'theory';
    state.currentTopicCardIndex = 0;
    saveState();
    navigate(state.activeView);
  }
}

// ==========================================================================
// ДВИЖОК ДАННЫХ (БАЗА ЗНАНИЙ)
// ==========================================================================
let examData = { topics: [] };

// Сбор всех терминов по всем темам для карточек
function getAllFlashcards() {
  const cards = [];
  examData.topics.forEach(topic => {
    if (state.cardFilter !== 'all' && topic.id !== state.cardFilter) {
      return;
    }
    topic.keyTerms.forEach(term => {
      cards.push({
        topicId: topic.id,
        category: topic.category,
        topicTitle: topic.title,
        term: term.term,
        definition: term.definition,
        id: term.id || `${topic.id}_${term.term.toLowerCase().replace(/\s+/g, '_')}`
      });
    });
  });
  return cards;
}

// Функция применения выбранного языка базы данных
function applyDbLanguage() {
  if (state.dbLang === 'ru') {
    examData = window.EXAM_DATA_RU || window.EXAM_DATA || { topics: [] };
  } else {
    examData = window.EXAM_DATA_KG || window.EXAM_DATA || { topics: [] };
  }
}

// Загрузка данных базы
async function fetchExamData() {
  try {
    if (window.EXAM_DATA_KG && window.EXAM_DATA_RU) {
      applyDbLanguage();
      return true;
    }
    if (window.EXAM_DATA) {
      examData = window.EXAM_DATA;
      return true;
    }
    const response = await fetch('data/exam-data.json');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    window.EXAM_DATA = data;
    applyDbLanguage();
    return true;
  } catch (error) {
    console.error('Не удалось загрузить базу данных.', error);
    examData = { topics: [] };
    return false;
  }
}

// ==========================================================================
// СИМУЛЯТОР УМНОГО ИИ-ОЦЕНЩИКА (ПО РУБРИКАМ)
// ==========================================================================
function evaluateOralAnswer(topicId, studentAnswer) {
  const topic = examData.topics.find(t => t.id === topicId);
  if (!topic) return null;

  const rubric = topic.examRubric;
  const answerLower = studentAnswer.toLowerCase().trim();

  // Если ответ слишком короткий или пустой
  if (answerLower.length < 10) {
    return {
      score: 0,
      grade: 'poor',
      missing: rubric.required,
      mistakes: ['Ответ слишком короткий или пустой'],
      feedback: 'Вы ничего не написали или ваш ответ слишком короткий. Предоставьте экзаменатору развернутый ответ.',
      idealAnswer: topic.shortAnswer
    };
  }

  let matchedRequired = [];
  let missingRequired = [];
  let matchedOptional = [];
  let detectedMistakes = [];

  // Проверка совпадения ключевых слов (фрагментов слов)
  const containsKeyword = (text, criteria) => {
    const options = criteria.split('/').map(opt => opt.trim().toLowerCase());
    return options.some(opt => {
      const words = opt.split(' ');
      return words.every(word => text.includes(word));
    });
  };

  // 1. Обязательные пункты (Вес: 60%)
  rubric.required.forEach(item => {
    if (containsKeyword(answerLower, item)) {
      matchedRequired.push(item);
    } else {
      missingRequired.push(item);
    }
  });

  // 2. Желательные / Дополнительные пункты (Вес: 20%)
  rubric.optional.forEach(item => {
    if (containsKeyword(answerLower, item)) {
      matchedOptional.push(item);
    }
  });

  // 3. Анализ типичных ошибок (Штраф: -15% за каждую ошибку)
  rubric.commonMistakes.forEach(item => {
    if (containsKeyword(answerLower, item)) {
      detectedMistakes.push(item);
    }
  });

  // Расчет промежуточного балла
  const reqCount = rubric.required.length;
  const optCount = rubric.optional.length;

  const reqScore = reqCount > 0 ? (matchedRequired.length / reqCount) * 60 : 60;
  const optScore = optCount > 0 ? (matchedOptional.length / optCount) * 20 : 20;

  // 4. Оценка качества формулировок и объема (Вес: 20%)
  let qualityScore = 0;
  const wordCount = studentAnswer.split(/\s+/).length;
  
  if (wordCount >= 15) qualityScore += 5;
  if (wordCount >= 35) qualityScore += 5;

  // Академичность (использование вводных, структурирующих и научных терминов)
  const expertWords = ['например', 'потому', 'создает', 'выделенный', 'обеспечивает', 'механизм', 'алгоритм', 'процесс', 'временный', 'протокол', 'устройство', 'уровень'];
  let expertWordCount = 0;
  expertWords.forEach(w => {
    if (answerLower.includes(w)) expertWordCount++;
  });
  if (expertWordCount >= 2) qualityScore += 5;
  if (expertWordCount >= 4) qualityScore += 5;

  let totalScore = Math.round(reqScore + optScore + qualityScore);
  
  // Применение штрафов за ошибки
  totalScore -= (detectedMistakes.length * 15);
  
  // Ограничение шкалы
  totalScore = Math.max(0, Math.min(100, totalScore));

  // Определение оценки
  let grade = 'poor';
  let feedback = '';
  if (totalScore >= 85) {
    grade = 'excellent';
    feedback = 'Отличный ответ! Вы раскрыли все ключевые элементы темы, использовали правильные термины и структуру. На экзамене это была бы оценка 5.';
  } else if (totalScore >= 70) {
    grade = 'good';
    feedback = 'Хороший ответ. Основные определения упомянуты, но рекомендуется углубить ваш ответ или добавить дополнительные механизмы (например, пример или дополнительные условия).';
  } else if (totalScore >= 50) {
    grade = 'fair';
    feedback = 'Удовлетворительный ответ. У вас есть понимание темы, но для достижения отличного уровня на экзамене необходимо более полно раскрыть ключевые слова и механизмы.';
  } else {
    grade = 'poor';
    feedback = 'Неудовлетворительный ответ. Тема не раскрыта полностью или содержатся серьезные ошибки. Рекомендуется изучить пропущенные пункты ниже и перечитать тему.';
  }

  if (detectedMistakes.length > 0) {
    feedback += ' Также в вашем ответе были замечены фактические неточности или ложные утверждения.';
  }

  // Обновление личного прогресса
  const prevBest = state.progress.topicScores[topicId] || 0;
  if (totalScore > prevBest) {
    state.progress.topicScores[topicId] = totalScore;
    saveState();
  }

  return {
    score: totalScore,
    grade,
    missing: missingRequired,
    present: matchedRequired,
    mistakes: detectedMistakes,
    feedback,
    idealAnswer: topic.shortAnswer
  };
}

// АСИНХРОННЫЙ ОЦЕНЩИК НА DEEPSEEK API
async function evaluateOralAnswerDeepSeek(topicId, studentAnswer) {
  const topic = examData.topics.find(t => t.id === topicId);
  if (!topic) return null;

  const answerTrimmed = studentAnswer.trim();

  // Если ответ пустой
  if (answerTrimmed.length < 10) {
    return {
      score: 0,
      grade: 'poor',
      missing: topic.examRubric.required,
      present: [],
      mistakes: ['Ответ слишком короткий или пустой'],
      feedback: 'Вы ничего не написали или ваш ответ слишком короткий. Предоставьте экзаменатору развернутый ответ.',
      idealAnswer: topic.shortAnswer
    };
  }

  // Если выбран локальный режим или API-ключ не задан
  if (state.aiEngine === 'local' || !state.apiKey) {
    const res = evaluateOralAnswer(topicId, studentAnswer);
    if (!state.apiKey) {
      res.feedback = "⚠️ Обратите внимание: оценка произведена локальным алгоритмом. Добавьте API ключ DeepSeek в настройках для подключения реального ИИ.\n\n" + res.feedback;
    } else {
      res.feedback = "⚠️ Обратите внимание: выбран локальный режим оценки. Для подключения реального ИИ переключите режим в настройках.\n\n" + res.feedback;
    }
    return res;
  }

  const systemPrompt = `Ты — строгий, но справедливый профессор компьютерной инженерии на государственном экзамене.
Твоя задача — оценить устный ответ студента по теме "${topic.title}".
Язык базы данных и учебного материала: ${state.dbLang === 'kg' ? 'Кыргызский' : 'Русский'}.
Ответ студента может быть предоставлен как на русском, так и на кыргызском языках.
Тебе предоставлены официальные критерии оценки:
- Идеальный краткий ответ: "${topic.shortAnswer}"
- Важные ключевые слова/критерии, которые обязательно должны быть затронуты (через слэш указаны варианты на русском/кыргызском):
  ${topic.examRubric.required.map(x => `- ${x}`).join('\n  ')}
- Желательные дополнительные элементы (необязательные, но повышают оценку):
  ${topic.examRubric.optional.map(x => `- ${x}`).join('\n  ')}
- Типичные ошибки (если они упоминаются, за них снижается балл):
  ${topic.examRubric.commonMistakes.map(x => `- ${x}`).join('\n  ')}

Пожалуйста, оцени ответ студента и верни результат строго в формате JSON со следующими полями:
{
  "score": <число от 0 до 100>,
  "grade": "<строка: 'excellent' | 'good' | 'fair' | 'poor' в зависимости от балла (85+ отлично, 70-84 хорошо, 50-69 удовл, <50 неудовл)>",
  "present": [<массив строк, какие из обязательных критериев студент упомянул в своем ответе>],
  "missing": [<массив строк, какие из обязательных критериев студент упустил в своем ответе>],
  "mistakes": [<массив строк, какие из типичных или общих ошибок были найдены в ответе>],
  "feedback": "<подробная конструктивная обратная связь на русском языке, объясняющая сильные стороны ответа, допущенные ошибки и что именно нужно подучить>",
  "idealAnswer": "<оригинальный идеальный ответ: ${topic.shortAnswer.replace(/"/g, '\\"')}>"
}

Очень важно: верни ТОЛЬКО валидный JSON без какого-либо разметки markdown (типа \`\`\`json ... \`\`\`) или текста вокруг него.`;

  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.apiKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: studentAnswer }
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    const result = JSON.parse(data.choices[0].message.content.trim());
    
    const evaluation = {
      score: typeof result.score === 'number' ? result.score : 50,
      grade: result.grade || 'fair',
      present: Array.isArray(result.present) ? result.present : [],
      missing: Array.isArray(result.missing) ? result.missing : [],
      mistakes: Array.isArray(result.mistakes) ? result.mistakes : [],
      feedback: result.feedback || 'Ответ успешно оценен ИИ.',
      idealAnswer: result.idealAnswer || topic.shortAnswer
    };

    // Обновление личного прогресса
    const prevBest = state.progress.topicScores[topicId] || 0;
    if (evaluation.score > prevBest) {
      state.progress.topicScores[topicId] = evaluation.score;
      saveState();
    }

    return evaluation;
  } catch (err) {
    console.error('Ошибка вызова DeepSeek API, откат к локальной оценке:', err);
    const localRes = evaluateOralAnswer(topicId, studentAnswer);
    localRes.feedback = `⚠️ Сбой DeepSeek API (используется локальный алгоритм): ${err.message}\n\n` + localRes.feedback;
    return localRes;
  }
}

// ==========================================================================
// АНАЛИТИКА И РЕКОМЕНДАЦИОННЫЙ ДВИЖОК
// ==========================================================================
function calculateReadiness() {
  if (examData.topics.length === 0) return 0;

  // 1. Изучение терминов по карточкам (Вес: 40%)
  const cards = getAllFlashcards();
  const totalCards = cards.length;
  let knowCards = 0;
  
  cards.forEach(c => {
    if (state.progress.cardStates[c.id] === 'know') {
      knowCards++;
    }
  });
  
  const cardRatio = totalCards > 0 ? (knowCards / totalCards) : 0;
  const cardScore = cardRatio * 40;

  // 2. Оценки за устные ответы (Вес: 60%)
  let totalOralScore = 0;
  examData.topics.forEach(topic => {
    totalOralScore += (state.progress.topicScores[topic.id] || 0);
  });
  const avgOralScore = totalOralScore / examData.topics.length;
  const oralScore = (avgOralScore / 100) * 60;

  return Math.round(cardScore + oralScore);
}

function getDailyRecommendations() {
  const recommendations = [];
  const cards = getAllFlashcards();
  
  // Рекомендация 1: Повторение сложных или отложенных карточек
  const hardCards = cards.filter(c => state.progress.cardStates[c.id] === 'hard' || state.progress.cardStates[c.id] === 'repeat');
  if (hardCards.length > 0) {
    const randomCard = hardCards[Math.floor(Math.random() * hardCards.length)];
    recommendations.push({
      type: 'card',
      iconClass: 'orange',
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/></svg>`,
      title: `Повторить термин: "${randomCard.term}"`,
      desc: `Этот термин из темы "${randomCard.topicTitle}" вызвал у вас сложности. Повторите карточку еще раз.`,
      actionText: 'К карте',
      onClick: () => {
        state.cardFilter = 'all';
        const updatedCards = getAllFlashcards();
        const cardIndex = updatedCards.findIndex(c => c.id === randomCard.id);
        state.currentCardIndex = cardIndex >= 0 ? cardIndex : 0;
        navigate('cards');
      }
    });
  }

  // Рекомендация 2: Подтянуть устную сдачу темы с низким баллом
  const weakTopics = examData.topics.map(topic => ({
    id: topic.id,
    title: topic.title,
    score: state.progress.topicScores[topic.id] || 0
  })).sort((a, b) => a.score - b.score);

  if (weakTopics.length > 0 && weakTopics[0].score < 70) {
    const weakest = weakTopics[0];
    const isUnattempted = weakest.score === 0;
    recommendations.push({
      type: 'topic',
      iconClass: 'purple',
      iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`,
      title: isUnattempted ? `Новая тема: "${weakest.title}"` : `Улучшить ответ: "${weakest.title}"`,
      desc: isUnattempted ? 'Вы еще не проходили устное тестирование по этой теме. Проверьте свои знания.' : `Ваш текущий балл невысокий (${weakest.score}/100). Учтите рекомендации ИИ и ответьте снова.`,
      actionText: 'К теме',
      onClick: () => {
        state.currentTopicId = weakest.id;
        navigate('topics');
      }
    });
  }

  // Рекомендация 3: Пройти тренировочный мини-экзамен
  recommendations.push({
    type: 'exam',
    iconClass: 'blue',
    iconSvg: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    title: 'Пройти мини-экзамен',
    desc: 'Пройдите мини-экзамен, включающий вопросы по каждой теме, чтобы проверить свой уровень подготовки.',
    actionText: 'Начать тест',
    onClick: () => {
      navigate('exam');
    }
  });

  return recommendations;
}

// Обновление глобального прогресс-бара
function updateGlobalProgressUI() {
  const readiness = calculateReadiness();
  const bar = document.getElementById('sidebar-readiness-bar');
  const percentText = document.getElementById('sidebar-readiness-percent');
  
  if (bar && percentText) {
    bar.style.width = `${readiness}%`;
    percentText.textContent = `${readiness}%`;
  }
}

// ==========================================================================
// ГЕНЕРАТОР МИНИ-ЭКЗАМЕНА
// ==========================================================================
function setupMiniExam() {
  if (examData.topics.length === 0) return;

  const questions = [];
  
  // 1. Формируем 3 тестовых вопроса с выбором ответа (MCQ)
  const shuffledTopics = [...examData.topics].sort(() => 0.5 - Math.random());
  const selectedTopicsForMc = shuffledTopics.slice(0, 3);

  // Собираем определения для дистракторов
  const allTerms = [];
  examData.topics.forEach(t => t.keyTerms.forEach(kt => allTerms.push(kt)));

  selectedTopicsForMc.forEach((topic, qIdx) => {
    // Выбираем случайный термин из темы
    const term = topic.keyTerms[Math.floor(Math.random() * topic.keyTerms.length)];
    
    // Выбираем 3 неверных определения
    const distractors = allTerms
      .filter(t => t.definition !== term.definition)
      .sort(() => 0.5 - Math.random())
      .slice(0, 3)
      .map(t => t.definition);

    // Перемешиваем варианты ответов
    const choices = [term.definition, ...distractors].sort(() => 0.5 - Math.random());
    const correctIndex = choices.indexOf(term.definition);

    questions.push({
      id: `q_mc_${qIdx}`,
      type: 'mc',
      topicId: topic.id,
      topicTitle: topic.title,
      question: `Какое определение термина "${term.term}" в теме "${topic.title}" является верным?`,
      choices: choices,
      correctIndex: correctIndex,
      selectedAnswerIndex: null
    });
  });

  // 2. Добавляем 2 открытых устных вопроса
  const selectedTopicsForOral = shuffledTopics.slice(0, 2);
  selectedTopicsForOral.forEach((topic, qIdx) => {
    questions.push({
      id: `q_oral_${qIdx}`,
      type: 'oral',
      topicId: topic.id,
      topicTitle: topic.title,
      question: `Объясните механизм "${topic.title}". Включите в ответ определение, принцип работы, пример и область применения.`,
      studentAnswer: '',
      evaluation: null
    });
  });

  state.activeExam = {
    questions: questions,
    currentQuestionIndex: 0,
    timeLeft: 300, // 5 минут
    timerInterval: null
  };
}

function startExamTimer(renderCallback) {
  if (!state.activeExam) return;
  
  state.activeExam.timerInterval = setInterval(() => {
    if (!state.activeExam) {
      clearInterval(state.activeExam.timerInterval);
      return;
    }
    
    state.activeExam.timeLeft--;
    
    const timerEl = document.getElementById('exam-time');
    if (timerEl) {
      const mins = Math.floor(state.activeExam.timeLeft / 60);
      const secs = state.activeExam.timeLeft % 60;
      timerEl.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    if (state.activeExam.timeLeft <= 0) {
      clearInterval(state.activeExam.timerInterval);
      alert('Время экзамена истекло! Ваши ответы отправлены на проверку.');
      finishExam();
    }
  }, 1000);
}

async function finishExam() {
  if (!state.activeExam) return;
  clearInterval(state.activeExam.timerInterval);

  // Показываем красивый полноэкранный загрузчик
  appRoot.innerHTML = `
    <div class="loading-state" style="padding: 150px 0; max-width: 500px; margin: 0 auto; text-align: center;">
      <div class="spinner" style="width: 50px; height: 50px; margin-bottom: 20px;"></div>
      <h3 style="font-family: var(--font-display); font-size: 1.5rem; font-weight: 700; margin-bottom: 10px;">
        ИИ-Экзаменатор оценивает ваши ответы...
      </h3>
      <p style="color: var(--text-secondary); line-height: 1.5; font-size: 0.95rem;">
        Мы отправляем ваши эссе на проверку через DeepSeek API по официальным критериям. Это может занять около 5-10 секунд. Пожалуйста, не закрывайте вкладку.
      </p>
    </div>
  `;

  let mcCorrectCount = 0;
  let mcTotal = 0;
  const oralQuestions = [];

  state.activeExam.questions.forEach(q => {
    if (q.type === 'mc') {
      mcTotal++;
      if (q.selectedAnswerIndex === q.correctIndex) {
        mcCorrectCount++;
      }
    } else if (q.type === 'oral') {
      oralQuestions.push(q);
    }
  });

  // Запускаем проверку устных ответов параллельно
  const evalPromises = oralQuestions.map(async (q) => {
    const evalResult = await evaluateOralAnswerDeepSeek(q.topicId, q.studentAnswer);
    q.evaluation = evalResult;
    return evalResult.score;
  });

  let oralScoreSum = 0;
  try {
    const scores = await Promise.all(evalPromises);
    oralScoreSum = scores.reduce((sum, s) => sum + s, 0);
  } catch (err) {
    console.error('Ошибка оценивания устных ответов в экзамене:', err);
  }

  const oralCount = oralQuestions.length;

  // Расчет итоговой взвешенной оценки (Тест — 30%, Эссе — 70%)
  const mcScoreComponent = mcTotal > 0 ? (mcCorrectCount / mcTotal) * 30 : 30;
  const oralScoreComponent = oralCount > 0 ? (oralScoreSum / (oralCount * 100)) * 70 : 70;
  const finalScore = Math.round(mcScoreComponent + oralScoreComponent);

  // Оценка
  let grade = 'poor';
  if (finalScore >= 85) grade = 'excellent';
  else if (finalScore >= 70) grade = 'good';
  else if (finalScore >= 50) grade = 'fair';

  const examAttempt = {
    date: new Date().toLocaleDateString('ru-RU', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    score: finalScore,
    grade: grade,
    totalQuestions: state.activeExam.questions.length
  };

  state.progress.examHistory.unshift(examAttempt);
  saveState();

  // Отрисовка экрана результатов
  renderExamResults(examAttempt);
}

// ==========================================================================
// ШАБЛОНЫ ОТРИСОВКИ СТРАНИЦ
// ==========================================================================
const appRoot = document.getElementById('app-root');

// Диспетчер роутера
function renderActiveView() {
  if (examData.topics.length === 0) {
    appRoot.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <p>Загрузка базы знаний...</p>
      </div>`;
    return;
  }

  // Обновление состояния пунктов меню
  document.querySelectorAll('.nav-item').forEach(btn => {
    if (btn.getAttribute('data-target') === state.activeView) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  switch (state.activeView) {
    case 'dashboard':
      renderDashboard();
      break;
    case 'topics':
      renderTopicsView();
      break;
    case 'cards':
      renderCardsView();
      break;
    case 'exam':
      renderExamView();
      break;
    case 'settings':
      renderSettingsView();
      break;
  }
}

// 1. ПАНЕЛЬ УПРАВЛЕНИЯ
function renderDashboard() {
  document.getElementById('page-title').textContent = 'Панель управления';

  const readiness = calculateReadiness();
  const recommendations = getDailyRecommendations();
  
  // Roadmap Grid по всем 19 темам
  const roadmapHtml = examData.topics.map(t => {
    const totalTerms = t.keyTerms.length;
    const knowTerms = t.keyTerms.filter(kt => state.progress.cardStates[kt.id] === 'know').length;
    const oralScore = state.progress.topicScores[t.id] || 0;
    
    let statusClass = 'unattempted';
    let statusLabel = 'Не начато';
    if (oralScore >= 70 && knowTerms === totalTerms) {
      statusClass = 'mastered';
      statusLabel = 'Освоено';
    } else if (oralScore > 0 || knowTerms > 0) {
      statusClass = 'studying';
      statusLabel = 'Изучается';
    }
    
    return `
      <div class="roadmap-card" data-id="${t.id}">
        <div class="roadmap-meta">
          <span class="roadmap-category">${t.category}</span>
          <span style="display: flex; align-items: center; gap: 6px; font-size: 0.75rem; font-weight: 600;">
            <span class="roadmap-status ${statusClass}"></span>
            ${statusLabel}
          </span>
        </div>
        <div class="roadmap-title">${t.title}</div>
        <div class="roadmap-stats">
          <span>Карточки: ${knowTerms}/${totalTerms}</span>
          <span>Экзамен: ${oralScore > 0 ? oralScore + '/100' : '—'}</span>
        </div>
      </div>
    `;
  }).join('');

  // Список рекомендаций
  const recsHtml = recommendations.map((rec, index) => `
    <div class="recommendation-item">
      <div class="rec-icon ${rec.iconClass}">
        ${rec.iconSvg}
      </div>
      <div class="rec-content">
        <div class="rec-title">${rec.title}</div>
        <div class="rec-desc">${rec.desc}</div>
      </div>
      <button class="rec-action-btn" id="rec-btn-${index}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </button>
    </div>`).join('');

  // Счетчики статистики
  const totalCards = getAllFlashcards().length;
  const studiedCards = Object.keys(state.progress.cardStates).length;
  const oralAttempts = Object.keys(state.progress.topicScores).filter(k => state.progress.topicScores[k] > 0).length;
  const examsCount = state.progress.examHistory.length;

  appRoot.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:24px">
      
      <!-- Сетка виджетов готовности и рекомендаций -->
      <div class="dashboard-grid">
        <!-- Левая часть: Готовность и кнопки -->
        <div style="display:flex; flex-direction:column; gap:24px">
          <!-- Виджет общей готовности -->
          <div class="dashboard-card glass readiness-hero">
            <div class="readiness-details">
              <h2>Ваш уровень готовности</h2>
              <p>Платформа рассчитывает вашу готовность на основе освоения карточек и оценок устных ответов от ИИ.</p>
              <button class="btn btn-primary" id="dash-start-btn">Начать тренировку</button>
            </div>
            <div class="dial-container">
              <svg viewBox="0 0 36 36" class="circular-chart">
                <path class="circle-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                <path class="circle-progress" id="dial-progress-arc" stroke-dasharray="0, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
              </svg>
              <div class="dial-percentage">${readiness}%</div>
            </div>
          </div>
        </div>

        <!-- Правая часть: Рекомендации ИИ -->
        <div class="dashboard-card glass" style="align-self: start; height: 100%;">
          <div class="dashboard-card-title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent)">
              <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
            </svg>
            Сегодняшние рекомендации ИИ
          </div>
          <div class="recommendations-list">
            ${recsHtml || '<div style="color:var(--text-secondary); text-align:center; padding:20px 0">Все рекомендации выполнены! Вы отлично справляетесь.</div>'}
          </div>
        </div>
      </div>

      <!-- Быстрая статистика -->
      <div class="stats-row">
        <div class="stat-card glass">
          <div class="stat-icon-wrapper" style="background:var(--accent-light); color:var(--accent)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/>
            </svg>
          </div>
          <div class="stat-info">
            <span class="stat-value">${studiedCards} / ${totalCards}</span>
            <span class="stat-label">Изучено карточек</span>
          </div>
        </div>

        <div class="stat-card glass">
          <div class="stat-icon-wrapper" style="background:rgba(175, 82, 222, 0.15); color:var(--purple)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
          </div>
          <div class="stat-info">
            <span class="stat-value">${oralAttempts} / ${examData.topics.length}</span>
            <span class="stat-label">Устных тем сдано</span>
          </div>
        </div>

        <div class="stat-card glass">
          <div class="stat-icon-wrapper" style="background:var(--success-light); color:var(--success)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          </div>
          <div class="stat-info">
            <span class="stat-value">${examsCount}</span>
            <span class="stat-label">Мини-экзаменов сдано</span>
          </div>
        </div>

        <div class="stat-card glass">
          <div class="stat-icon-wrapper" style="background:var(--warning-light); color:var(--warning)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
          </div>
          <div class="stat-info">
            <span class="stat-value">${state.progress.examHistory[0] ? state.progress.examHistory[0].score + '%' : '—'}</span>
            <span class="stat-label">Последний балл экзамена</span>
          </div>
        </div>
      </div>

      <!-- Карта освоения тем (19 разделов) -->
      <section class="roadmap-section">
        <h3 class="roadmap-header">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent)">
            <path d="M9 18l6-6-6-6"/>
          </svg>
          Интерактивная карта освоения тем (${examData.topics.length} разделов)
        </h3>
        <div class="roadmap-grid">
          ${roadmapHtml}
        </div>
      </section>

    </div>
  `;

  // Анимация диска готовности
  setTimeout(() => {
    const arc = document.getElementById('dial-progress-arc');
    if (arc) {
      arc.setAttribute('stroke-dasharray', `${readiness}, 100`);
    }
  }, 100);

  // Привязка обработчиков для рекомендаций
  recommendations.forEach((rec, idx) => {
    const btn = document.getElementById(`rec-btn-${idx}`);
    if (btn) {
      btn.addEventListener('click', rec.onClick);
    }
  });

  // Переход по карте тем при клике
  document.querySelectorAll('.roadmap-card').forEach(card => {
    card.addEventListener('click', () => {
      const topicId = card.getAttribute('data-id');
      state.currentTopicId = topicId;
      state.currentTopicTab = 'theory'; // по умолчанию на теорию
      state.activeView = 'topics';
      renderActiveView();
    });
  });

  // Действие кнопки CTA
  const startBtn = document.getElementById('dash-start-btn');
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      state.activeView = 'topics';
      renderActiveView();
    });
  }
}

// 2. ТЕМЫ ОБУЧЕНИЯ (УЧЕБНЫЕ МОДУЛИ)
function renderTopicsView() {
  document.getElementById('page-title').textContent = 'Темы обучения';

  const topicsListHtml = examData.topics.map(t => {
    const activeClass = t.id === state.currentTopicId ? 'active' : '';
    const score = state.progress.topicScores[t.id] || 0;
    
    return `
      <button class="topic-selector-item ${activeClass}" data-id="${t.id}">
        <span class="topic-sel-category">${t.category}</span>
        <span class="topic-sel-title">${t.title}</span>
        <div class="topic-sel-progress-container">
          <span class="topic-sel-progress-label">Балл: ${score}/100</span>
          <div class="topic-sel-progress-bar-bg">
            <div class="topic-sel-progress-bar" style="width: ${score}%"></div>
          </div>
        </div>
      </button>`;
  }).join('');

  const activeTopic = examData.topics.find(t => t.id === state.currentTopicId) || examData.topics[0];

  // Рендер глоссария
  const termsHtml = activeTopic.keyTerms.map(kt => `
    <div class="term-card">
      <div class="term-name">${kt.term}</div>
      <div class="term-desc">${kt.definition}</div>
    </div>`).join('');

  // Рендер таблиц
  const tablesHtml = activeTopic.tables ? activeTopic.tables.map(table => {
    const headersHtml = table.headers.map(h => `<th>${h}</th>`).join('');
    const rowsHtml = table.rows.map(row => {
      const cols = row.map(col => `<td>${col}</td>`).join('');
      return `<tr>${cols}</tr>`;
    }).join('');

    return `
      <div style="margin-top: 15px">
        <h4 style="font-size: 0.95rem; font-weight: 600; margin-bottom: 8px">${table.title}</h4>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>${headersHtml}</tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      </div>`;
  }).join('') : '';

  // Рендер примеров
  const examplesHtml = activeTopic.examples.map(ex => `
    <div class="example-box">
      <div class="example-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
        </svg>
        ${ex.title}
      </div>
      <div class="example-desc">${ex.description}</div>
    </div>`).join('');

  // Логика переключения табов
  let tabContentHtml = '';
  if (state.currentTopicTab === 'theory') {
    tabContentHtml = `
      <section class="topic-section">
        <div class="topic-section-title">Краткое определение</div>
        <p class="topic-text" style="font-size: 1.05rem; font-weight: 500">${activeTopic.shortAnswer}</p>
      </section>

      <section class="topic-section">
        <div class="topic-section-title">Принцип работы и механизмы</div>
        <p class="topic-text">${activeTopic.explanation}</p>
        ${tablesHtml}
      </section>

      <section class="topic-section">
        <div class="topic-section-title">Ключевые термины</div>
        <div class="terms-grid">
          ${termsHtml}
        </div>
      </section>

      <section class="topic-section">
        <div class="topic-section-title">Понятные примеры</div>
        <div style="display:flex; flex-direction:column; gap:16px">
          ${examplesHtml}
        </div>
      </section>

      <section class="topic-section">
        <div class="topic-section-title">Готовый устный ответ на экзамене</div>
        <div class="verbal-answer-box">
          <h4 class="verbal-title">Эталонный короткий ответ (для ИИ-оценки):</h4>
          <blockquote class="verbal-quote">
            "${activeTopic.shortAnswer}"
          </blockquote>
        </div>
      </section>
    `;
  } else if (state.currentTopicTab === 'cards') {
    const topicTerms = activeTopic.keyTerms;
    if (state.currentTopicCardIndex >= topicTerms.length) {
      state.currentTopicCardIndex = 0;
    }
    const activeTerm = topicTerms[state.currentTopicCardIndex];
    const cardState = state.progress.cardStates[activeTerm.id] || 'unstudied';
    const flippedClass = state.flashcardFlipped ? 'flipped' : '';
    
    let stateBadgeHtml = '';
    if (cardState === 'know') {
      stateBadgeHtml = '<span style="background:var(--success-light); color:var(--success); padding:4px 8px; border-radius:4px; font-size:0.75rem; font-weight:700">Знаю</span>';
    } else if (cardState === 'repeat') {
      stateBadgeHtml = '<span style="background:var(--warning-light); color:var(--warning); padding:4px 8px; border-radius:4px; font-size:0.75rem; font-weight:700">Повторить</span>';
    } else if (cardState === 'hard') {
      stateBadgeHtml = '<span style="background:var(--danger-light); color:var(--danger); padding:4px 8px; border-radius:4px; font-size:0.75rem; font-weight:700">Сложно</span>';
    }

    tabContentHtml = `
      <div style="display:flex; flex-direction:column; gap:20px; align-items:center;">
        <div style="display:flex; justify-content:space-between; width:100%; align-items:center">
          <span style="font-weight:600; font-size:0.9rem; color:var(--text-secondary)">Карточка: ${state.currentTopicCardIndex + 1} из ${topicTerms.length}</span>
          ${stateBadgeHtml}
        </div>
        
        <!-- 3D Контейнер карточки -->
        <div class="flashcard-wrapper ${flippedClass}" id="topic-card-flip-trigger" style="width:100%; max-width:600px; height: 260px;">
          <div class="flashcard">
            <!-- ЛИЦЕВАЯ СТОРОНА -->
            <div class="card-face card-front glass">
              <span class="card-meta">${activeTopic.category}</span>
              <div class="card-question">Что означает "${activeTerm.term}"?</div>
              <div class="card-hint">Вспомните ответ и нажмите для переворота</div>
            </div>

            <!-- ОБРАТНАЯ СТОРОНА -->
            <div class="card-face card-back glass">
              <span class="card-meta" style="color:var(--accent)">Ответ: ${activeTerm.term}</span>
              <div class="card-answer" style="font-size: 1.05rem;">${activeTerm.definition}</div>
              <div class="card-hint" style="color:var(--text-secondary)">Оцените ваш ответ:</div>
            </div>
          </div>
        </div>

        <!-- Кнопки самооценки -->
        <div class="flashcard-actions" style="display:flex; gap:12px; width:100%; max-width:600px; justify-content:center">
          <button class="btn btn-danger btn-card" id="topic-card-btn-hard" style="flex:1">Сложно</button>
          <button class="btn btn-secondary btn-card" id="topic-card-btn-repeat" style="background:var(--warning-light); color:var(--warning); flex:1">Повторить</button>
          <button class="btn btn-success btn-card" id="topic-card-btn-know" style="flex:1">Знаю</button>
        </div>

        <!-- Навигация -->
        <div style="display:flex; justify-content:space-between; width:100%; max-width:600px; margin-top:10px">
          <button class="btn btn-secondary" id="topic-card-prev-btn" ${state.currentTopicCardIndex === 0 ? 'disabled' : ''}>
            Назад
          </button>
          <button class="btn btn-secondary" id="topic-card-next-btn" ${state.currentTopicCardIndex === topicTerms.length - 1 ? 'disabled' : ''}>
            Вперед
          </button>
        </div>
      </div>
    `;
  } else if (state.currentTopicTab === 'practice') {
    const score = state.progress.topicScores[activeTopic.id] || 0;
    let scoreStatusHtml = `<span style="color:var(--text-secondary)">Вы еще не сдавали устный экзамен по этой теме.</span>`;
    if (score >= 85) {
      scoreStatusHtml = `<span style="color:var(--success); font-weight:700">Отлично (${score}/100) — Тема освоена!</span>`;
    } else if (score >= 70) {
      scoreStatusHtml = `<span style="color:var(--accent); font-weight:700">Хорошо (${score}/100) — Хороший результат.</span>`;
    } else if (score >= 50) {
      scoreStatusHtml = `<span style="color:var(--warning); font-weight:700">Удовлетворительно (${score}/100) — Стоит повторить.</span>`;
    } else if (score > 0) {
      scoreStatusHtml = `<span style="color:var(--danger); font-weight:700">Неудовлетворительно (${score}/100) — Тема не пройдена.</span>`;
    }

    tabContentHtml = `
      <div class="ai-sim-feedback-panel" style="margin-top:0; border:none; padding:0; background:transparent">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; border-bottom:1px solid var(--border-color); padding-bottom:12px">
          <h3 class="ai-sim-headline" style="margin-bottom:0">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent)">
              <circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/>
            </svg>
            Устная ИИ-проверка (DeepSeek AI)
          </h3>
          <div style="font-size:0.85rem">${scoreStatusHtml}</div>
        </div>
        <p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:20px; line-height:1.4">
          Напишите ваш подробный ответ на экзаменационный вопрос. ИИ-Экзаменатор оценит глубину раскрытия темы, проверит ключевые термины, выставит оценку и укажет на ошибки.
        </p>
        <div class="oral-response-form">
          <div class="text-area-wrapper">
            <textarea id="oral-answer-input" class="oral-textarea" placeholder="Например: ${activeTopic.title} это... Механизм его работы... Пример..."></textarea>
            <div class="word-counter" id="word-counter-label">Слов: 0</div>
          </div>
          <div style="display: flex; gap: 12px">
            <button class="btn btn-success" id="submit-oral-answer-btn" style="padding:10px 24px">Отправить ответ на проверку</button>
          </div>
        </div>

        <!-- Результат ИИ оценки -->
        <div id="ai-evaluation-result" style="display: none; margin-top: 24px; padding-top: 24px; border-top:1px dashed var(--border-color)">
        </div>
      </div>
    `;
  }

  appRoot.innerHTML = `
    <div class="topics-layout">
      <!-- Левая боковая колонка списка тем -->
      <aside class="topics-nav-list glass">
        ${topicsListHtml}
      </aside>

      <!-- Правое детальное окно темы -->
      <article class="topic-viewer-card glass" id="topic-detail-pane">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px">
          <div class="topic-meta">
            <span class="category-badge">${activeTopic.category}</span>
          </div>
          
          <!-- Вкладки управления обучением -->
          <div class="topic-tab-container" style="margin-bottom:0">
            <button class="topic-tab-btn ${state.currentTopicTab === 'theory' ? 'active' : ''}" data-tab="theory">Теория</button>
            <button class="topic-tab-btn ${state.currentTopicTab === 'cards' ? 'active' : ''}" data-tab="cards">Карточки (${activeTopic.keyTerms.length})</button>
            <button class="topic-tab-btn ${state.currentTopicTab === 'practice' ? 'active' : ''}" data-tab="practice">ИИ-Экзаменатор</button>
          </div>
        </div>
        
        <h2 class="topic-title" style="margin-bottom:24px">${activeTopic.title}</h2>

        <div id="topic-tab-content">
          ${tabContentHtml}
        </div>
      </article>
    </div>`;

  // Смена активных тем
  document.querySelectorAll('.topic-selector-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const topicId = btn.getAttribute('data-id');
      state.currentTopicId = topicId;
      state.currentTopicCardIndex = 0;
      state.flashcardFlipped = false;
      renderActiveView();
    });
  });

  // Логика табов
  document.querySelectorAll('.topic-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.currentTopicTab = btn.getAttribute('data-tab');
      state.flashcardFlipped = false;
      saveState();
      renderActiveView();
    });
  });

  // Логика карточек внутри темы
  if (state.currentTopicTab === 'cards') {
    const cardWrapper = document.getElementById('topic-card-flip-trigger');
    if (cardWrapper) {
      cardWrapper.addEventListener('click', () => {
        state.flashcardFlipped = !state.flashcardFlipped;
        cardWrapper.classList.toggle('flipped', state.flashcardFlipped);
      });
    }

    const topicTerms = activeTopic.keyTerms;
    const activeTerm = topicTerms[state.currentTopicCardIndex];

    const handleTopicCardAssessment = (assessmentType) => {
      state.progress.cardStates[activeTerm.id] = assessmentType;
      saveState();

      setTimeout(() => {
        if (state.currentTopicCardIndex < topicTerms.length - 1) {
          state.currentTopicCardIndex++;
          state.flashcardFlipped = false;
          renderActiveView();
        } else {
          if (confirm('Поздравляем! Вы прошли все карточки по этой теме. Хотите сдать устный экзамен ИИ?')) {
            state.currentTopicTab = 'practice';
            state.currentTopicCardIndex = 0;
            saveState();
            renderActiveView();
          } else {
            state.currentTopicCardIndex = 0;
            state.flashcardFlipped = false;
            renderActiveView();
          }
        }
      }, 150);
    };

    const btnHard = document.getElementById('topic-card-btn-hard');
    const btnRepeat = document.getElementById('topic-card-btn-repeat');
    const btnKnow = document.getElementById('topic-card-btn-know');

    if (btnHard) btnHard.addEventListener('click', (e) => { e.stopPropagation(); handleTopicCardAssessment('hard'); });
    if (btnRepeat) btnRepeat.addEventListener('click', (e) => { e.stopPropagation(); handleTopicCardAssessment('repeat'); });
    if (btnKnow) btnKnow.addEventListener('click', (e) => { e.stopPropagation(); handleTopicCardAssessment('know'); });

    const btnPrev = document.getElementById('topic-card-prev-btn');
    const btnNext = document.getElementById('topic-card-next-btn');

    if (btnPrev) {
      btnPrev.addEventListener('click', () => {
        if (state.currentTopicCardIndex > 0) {
          state.currentTopicCardIndex--;
          state.flashcardFlipped = false;
          renderActiveView();
        }
      });
    }
    if (btnNext) {
      btnNext.addEventListener('click', () => {
        if (state.currentTopicCardIndex < topicTerms.length - 1) {
          state.currentTopicCardIndex++;
          state.flashcardFlipped = false;
          renderActiveView();
        }
      });
    }
  }

  // Логика тренажера ИИ
  if (state.currentTopicTab === 'practice') {
    const submitOralBtn = document.getElementById('submit-oral-answer-btn');
    const oralTextarea = document.getElementById('oral-answer-input');
    const wordCounter = document.getElementById('word-counter-label');

    if (oralTextarea) {
      oralTextarea.addEventListener('input', () => {
        const words = oralTextarea.value.trim() === '' ? 0 : oralTextarea.value.trim().split(/\s+/).length;
        wordCounter.textContent = `Слов: ${words}`;
      });
    }

    if (submitOralBtn && oralTextarea) {
      submitOralBtn.addEventListener('click', async () => {
        const text = oralTextarea.value.trim();
        if (!text) {
          alert('Пожалуйста, введите ваш ответ перед отправкой!');
          return;
        }

        const resultContainer = document.getElementById('ai-evaluation-result');
        if (resultContainer) {
          resultContainer.innerHTML = `
            <div class="loading-state" style="padding: 30px 0;">
              <div class="spinner"></div>
              <p>ИИ-Экзаменатор анализирует ваш ответ по критериям... Пожалуйста, подождите.</p>
            </div>
          `;
          resultContainer.style.display = 'block';
          resultContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        submitOralBtn.disabled = true;
        const originalText = submitOralBtn.innerHTML;
        submitOralBtn.innerHTML = `<span class="spinner" style="width:14px; height:14px; border-width:2px; display:inline-block; margin-right:8px; animation: spin 1s linear infinite;"></span> Оценивание...`;

        try {
          const evaluation = await evaluateOralAnswerDeepSeek(activeTopic.id, text);
          if (evaluation) {
            displayAIEvalResult(evaluation);
          }
        } catch (e) {
          console.error(e);
          alert('Произошла ошибка при отправке запроса к ИИ.');
        } finally {
          submitOralBtn.disabled = false;
          submitOralBtn.innerHTML = originalText;
        }
      });
    }
  }
}

// Отображение детализации устной оценки ИИ
function displayAIEvalResult(res) {
  const container = document.getElementById('ai-evaluation-result');
  if (!container) return;

  let gradeBadgeClass = 'grade-poor';
  let gradeLabel = 'Неудовлетворительно (2)';
  if (res.grade === 'excellent') {
    gradeBadgeClass = 'grade-excellent';
    gradeLabel = 'Отлично (5)';
  } else if (res.grade === 'good') {
    gradeBadgeClass = 'grade-good';
    gradeLabel = 'Хорошо (4)';
  } else if (res.grade === 'fair') {
    gradeBadgeClass = 'grade-fair';
    gradeLabel = 'Удовлетворительно (3)';
  }

  const presentItemsHtml = res.present.map(item => `
    <li class="ai-sim-bullet-present" style="color:var(--text-primary)">
      <strong style="color:var(--success)">Упомянуто:</strong> ${item.split('/')[0]}
    </li>`).join('');

  const missingItemsHtml = res.missing.map(item => `
    <li class="ai-sim-bullet-missing" style="color:var(--text-secondary)">
      <strong style="color:var(--danger)">Пропущено:</strong> ${item.split('/')[0]}
    </li>`).join('');

  const mistakesItemsHtml = res.mistakes.map(item => `
    <li class="ai-sim-bullet-mistake" style="color:var(--text-primary)">
      <strong style="color:var(--warning)">Замечание:</strong> ${item}
    </li>`).join('');

  container.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:20px">
      <div style="display:flex; align-items:center; justify-content:space-between">
        <div>
          <span class="results-grade-badge ${gradeBadgeClass}">${gradeLabel}</span>
          <h4 style="font-size:1.5rem; font-weight:800; font-family:var(--font-display)">${res.score} <span style="font-size:0.9rem; font-weight:400; color:var(--text-secondary)">баллов / 100</span></h4>
        </div>
        <div style="text-align:right">
          <span style="font-size:0.8rem; text-transform:uppercase; color:var(--text-secondary)">Уровень готовности</span>
          <p style="font-weight:600; font-size:1rem">${res.grade === 'excellent' ? 'Специалист' : (res.grade === 'good' ? 'Отличная готовность' : 'Нужно потренироваться')}</p>
        </div>
      </div>

      <div class="feedback-section" style="border-left:4px solid ${res.score >= 70 ? 'var(--success)' : (res.score >= 50 ? 'var(--warning)' : 'var(--danger)')}">
        <div class="feedback-title">Анализ ответа от ИИ-экзаменатора:</div>
        <p class="feedback-text">${res.feedback}</p>
      </div>

      <div class="ai-sim-grid">
        <div class="ai-sim-column">
          <h4>Критерии ответа</h4>
          <ul class="ai-sim-bullets present-items" style="display:flex; flex-direction:column; gap:8px">
            ${presentItemsHtml || '<li style="color:var(--text-secondary)">Критерии не определены</li>'}
            ${missingItemsHtml}
          </ul>
        </div>

        <div class="ai-sim-column">
          <h4>Ошибки и замечания</h4>
          <ul class="ai-sim-bullets mistakes" style="display:flex; flex-direction:column; gap:8px">
            ${mistakesItemsHtml || '<li style="color:var(--text-secondary); list-style:none">Грубых ошибок в ответе не обнаружено. Все в порядке!</li>'}
          </ul>
          
          <div style="margin-top:20px; padding:12px; background:var(--bg-primary); border-radius:var(--radius-sm)">
            <h5 style="font-weight:700; font-size:0.8rem; margin-bottom:4px">Рекомендуемый эталонный ответ:</h5>
            <p style="font-size:0.8rem; font-style:italic; line-height:1.4">${res.idealAnswer}</p>
          </div>
        </div>
      </div>
    </div>
  `;

  container.style.display = 'block';
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// 3. КАРТОЧКИ ТЕРМИНОВ
function renderCardsView() {
  document.getElementById('page-title').textContent = 'Карточки терминов';

  const cards = getAllFlashcards();
  
  const categoriesHtml = examData.topics.map(t => {
    const selected = t.id === state.cardFilter ? 'selected' : '';
    return `<option value="${t.id}" ${selected}>${t.title}</option>`;
  }).join('');

  if (cards.length === 0) {
    appRoot.innerHTML = `
      <div style="max-width:500px; margin: 40px auto; text-align:center">
        <h3 style="font-family:var(--font-display); font-size:1.3rem; margin-bottom:12px">Карточки отсутствуют</h3>
        <p style="color:var(--text-secondary); margin-bottom:20px">В этой теме терминов не найдено.</p>
        <select id="card-filter-select" class="btn btn-secondary" style="margin: 0 auto; display:block">
          <option value="all">Все темы</option>
          ${categoriesHtml}
        </select>
      </div>`;
      
    const select = document.getElementById('card-filter-select');
    if (select) {
      select.addEventListener('change', (e) => {
        state.cardFilter = e.target.value;
        state.currentCardIndex = 0;
        renderActiveView();
      });
    }
    return;
  }

  if (state.currentCardIndex >= cards.length) {
    state.currentCardIndex = 0;
  }

  const activeCard = cards[state.currentCardIndex];
  const cardState = state.progress.cardStates[activeCard.id] || 'unstudied';
  const flippedClass = state.flashcardFlipped ? 'flipped' : '';

  let stateBadgeHtml = '';
  if (cardState === 'know') {
    stateBadgeHtml = '<span style="background:var(--success-light); color:var(--success); padding:4px 8px; border-radius:4px; font-size:0.75rem; font-weight:700">Знаю</span>';
  } else if (cardState === 'repeat') {
    stateBadgeHtml = '<span style="background:var(--warning-light); color:var(--warning); padding:4px 8px; border-radius:4px; font-size:0.75rem; font-weight:700">Повторить</span>';
  } else if (cardState === 'hard') {
    stateBadgeHtml = '<span style="background:var(--danger-light); color:var(--danger); padding:4px 8px; border-radius:4px; font-size:0.75rem; font-weight:700">Сложно</span>';
  }

  appRoot.innerHTML = `
    <div class="flashcards-layout">
      <div class="flashcard-header-bar">
        <div>
          <select id="card-filter-select" class="btn btn-secondary" style="padding:6px 12px; font-size:0.85rem">
            <option value="all">Все темы</option>
            ${categoriesHtml}
          </select>
        </div>
        <div>
          Карточка: ${state.currentCardIndex + 1} / ${cards.length}
          ${stateBadgeHtml}
        </div>
      </div>

      <!-- 3D Контейнер карточки -->
      <div class="flashcard-wrapper ${flippedClass}" id="card-flip-trigger">
        <div class="flashcard">
          <!-- ЛИЦЕВАЯ СТОРОНА -->
          <div class="card-face card-front glass">
            <span class="card-meta">${activeCard.category}</span>
            <div class="card-question">Что такое "${activeCard.term}"?</div>
            <div class="card-hint">Вспомните определение и кликните для проверки</div>
          </div>

          <!-- ОБРАТНАЯ СТОРОНА -->
          <div class="card-face card-back glass">
            <span class="card-meta" style="color:var(--accent)">Ответ: ${activeCard.term}</span>
            <div class="card-answer">${activeCard.definition}</div>
            <div class="card-hint" style="color:var(--text-secondary)">Насколько простым был ответ? Оцените ниже</div>
          </div>
        </div>
      </div>

      <!-- Кнопки самооценки -->
      <div class="flashcard-actions">
        <button class="btn btn-danger btn-card" id="card-btn-hard">Сложно (Hard)</button>
        <button class="btn btn-secondary btn-card" id="card-btn-repeat" style="background:var(--warning-light); color:var(--warning)">Повторить</button>
        <button class="btn btn-success btn-card" id="card-btn-know">Знаю (Know)</button>
      </div>

      <!-- Навигация стрелками -->
      <div style="display:flex; justify-content:space-between; width:100%; margin-top: 10px">
        <button class="btn btn-secondary" id="card-prev-btn" ${state.currentCardIndex === 0 ? 'disabled' : ''}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Назад
        </button>
        <button class="btn btn-secondary" id="card-next-btn" ${state.currentCardIndex === cards.length - 1 ? 'disabled' : ''}>
          Вперед
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </button>
      </div>
    </div>`;

  const filterSelect = document.getElementById('card-filter-select');
  if (filterSelect) {
    filterSelect.addEventListener('change', (e) => {
      state.cardFilter = e.target.value;
      state.currentCardIndex = 0;
      state.flashcardFlipped = false;
      renderActiveView();
    });
  }

  const cardWrapper = document.getElementById('card-flip-trigger');
  if (cardWrapper) {
    cardWrapper.addEventListener('click', () => {
      state.flashcardFlipped = !state.flashcardFlipped;
      cardWrapper.classList.toggle('flipped', state.flashcardFlipped);
    });
  }

  const handleAssessment = (assessmentType) => {
    state.progress.cardStates[activeCard.id] = assessmentType;
    saveState();
    
    setTimeout(() => {
      if (state.currentCardIndex < cards.length - 1) {
        state.currentCardIndex++;
        state.flashcardFlipped = false;
        renderActiveView();
      } else {
        alert('Поздравляем! Вы просмотрели все карточки по этой теме.');
        state.flashcardFlipped = false;
        renderActiveView();
      }
    }, 300);
  };

  const btnHard = document.getElementById('card-btn-hard');
  const btnRepeat = document.getElementById('card-btn-repeat');
  const btnKnow = document.getElementById('card-btn-know');

  if (btnHard) btnHard.addEventListener('click', (e) => { e.stopPropagation(); handleAssessment('hard'); });
  if (btnRepeat) btnRepeat.addEventListener('click', (e) => { e.stopPropagation(); handleAssessment('repeat'); });
  if (btnKnow) btnKnow.addEventListener('click', (e) => { e.stopPropagation(); handleAssessment('know'); });

  const btnPrev = document.getElementById('card-prev-btn');
  const btnNext = document.getElementById('card-next-btn');

  if (btnPrev) {
    btnPrev.addEventListener('click', () => {
      if (state.currentCardIndex > 0) {
        state.currentCardIndex--;
        state.flashcardFlipped = false;
        renderActiveView();
      }
    });
  }

  if (btnNext) {
    btnNext.addEventListener('click', () => {
      if (state.currentCardIndex < cards.length - 1) {
        state.currentCardIndex++;
        state.flashcardFlipped = false;
        renderActiveView();
      }
    });
  }
}

// 4. МИНИ-ЭКЗАМЕН
function renderExamView() {
  document.getElementById('page-title').textContent = 'Мини-экзамен';

  if (!state.activeExam) {
    renderExamSetup();
    return;
  }

  renderExamQuestion();
}

function renderExamSetup() {
  const historyHtml = state.progress.examHistory.map(h => {
    let gradeLabel = 'Неудовлетворительно (2)';
    let color = 'var(--danger)';
    if (h.grade === 'excellent') { gradeLabel = 'Отлично (5)'; color = 'var(--success)'; }
    else if (h.grade === 'good') { gradeLabel = 'Хорошо (4)'; color = 'var(--accent)'; }
    else if (h.grade === 'fair') { gradeLabel = 'Удовлетворительно (3)'; color = 'var(--warning)'; }

    return `
      <tr>
        <td>${h.date}</td>
        <td style="font-weight:700">${h.score}%</td>
        <td style="font-weight:600; color:${color}">${gradeLabel}</td>
      </tr>`;
  }).join('');

  appRoot.innerHTML = `
    <div class="exam-setup-box glass">
      <div class="exam-setup-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 10v6M2 10l10-5 10 5-10 5z"/>
          <path d="M6 12v5c0 2 2 3 6 3s6-1 6-3v-5"/>
        </svg>
      </div>
      <h2>Государственный мини-экзамен</h2>
      <p>
        Система выберет случайные вопросы по каждой теме и подготовит тест из 5 вопросов.<br/>
        Он состоит из 3 вопросов теста (проверка знаний) и 2 открытых устных вопросов (проверка ИИ).<br/>
        На экзамен дается 5 минут.
      </p>

      <div class="exam-stats-list">
        <div class="exam-stat-item">
          <span class="exam-stat-val">${state.progress.examHistory.length}</span>
          <span class="exam-stat-lbl">Попытки</span>
        </div>
        <div class="exam-stat-item">
          <span class="exam-stat-val" style="color:var(--success)">
            ${state.progress.examHistory.length > 0 ? Math.max(...state.progress.examHistory.map(h => h.score)) + '%' : '—'}
          </span>
          <span class="exam-stat-lbl">Макс. балл</span>
        </div>
      </div>

      <button class="btn btn-primary" id="start-exam-trigger-btn" style="padding:12px 30px">Сдать экзамен</button>

      ${state.progress.examHistory.length > 0 ? `
      <div style="width:100%; margin-top:40px; border-top:1px solid var(--border-color); padding-top:20px">
        <h4 style="font-family:var(--font-display); font-size:1.1rem; margin-bottom:12px">История результатов экзаменов</h4>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Общий балл</th>
                <th>Оценка</th>
              </tr>
            </thead>
            <tbody>
              ${historyHtml}
            </tbody>
          </table>
        </div>
      </div>` : ''}
    </div>`;

  const trigger = document.getElementById('start-exam-trigger-btn');
  if (trigger) {
    trigger.addEventListener('click', () => {
      setupMiniExam();
      renderActiveView();
      startExamTimer();
    });
  }
}

function renderExamQuestion() {
  const exam = state.activeExam;
  if (!exam) return;

  const currentQ = exam.questions[exam.currentQuestionIndex];
  const isLast = exam.currentQuestionIndex === exam.questions.length - 1;

  const progressPercent = Math.round((exam.currentQuestionIndex / exam.questions.length) * 100);
  
  const mins = Math.floor(exam.timeLeft / 60);
  const secs = exam.timeLeft % 60;
  const timeFormatted = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

  let optionsHtml = '';
  if (currentQ.type === 'mc') {
    optionsHtml = currentQ.choices.map((choice, index) => {
      const isSelected = currentQ.selectedAnswerIndex === index ? 'selected' : '';
      return `
        <div class="mc-option ${isSelected}" data-index="${index}">
          <div class="mc-radio"></div>
          <span>${choice}</span>
        </div>`;
    }).join('');
  }

  let questionBodyHtml = '';
  if (currentQ.type === 'mc') {
    questionBodyHtml = `
      <div class="mc-options-list">
        ${optionsHtml}
      </div>`;
  } else if (currentQ.type === 'oral') {
    questionBodyHtml = `
      <div class="oral-response-form">
        <div class="text-area-wrapper">
          <textarea id="exam-oral-textarea" class="oral-textarea" placeholder="Напишите ваш ответ на вопрос полностью...">${currentQ.studentAnswer}</textarea>
          <div class="word-counter" id="exam-word-counter-lbl">Слов: ${currentQ.studentAnswer.trim() === '' ? 0 : currentQ.studentAnswer.trim().split(/\s+/).length}</div>
        </div>
      </div>`;
  }

  appRoot.innerHTML = `
    <div class="exam-runner">
      <div class="exam-progress-bar-wrapper">
        <span>Вопрос: ${exam.currentQuestionIndex + 1} / ${exam.questions.length}</span>
        <span class="exam-timer" id="exam-time">${timeFormatted}</span>
      </div>
      <div class="progress-bar-container" style="margin-bottom: 24px">
        <div class="progress-bar" style="width: ${progressPercent}%"></div>
      </div>

      <div class="exam-body-card glass">
        <div class="exam-question-header">
          <span class="exam-q-num">${currentQ.topicTitle}</span>
          <span class="exam-q-type">${currentQ.type === 'mc' ? 'ТЕСТ' : 'УСТНЫЙ ОТВЕТ'}</span>
        </div>
        <h3 class="exam-question-title">${currentQ.question}</h3>

        ${questionBodyHtml}
      </div>

      <div style="display:flex; justify-content:space-between">
        <button class="btn btn-secondary" id="exam-prev-btn" ${exam.currentQuestionIndex === 0 ? 'disabled' : ''}>Назад</button>
        
        ${isLast ? `
          <button class="btn btn-success" id="exam-finish-btn">Завершить экзамен</button>
        ` : `
          <button class="btn btn-primary" id="exam-next-btn">Вперед</button>
        `}
      </div>
    </div>`;

  if (currentQ.type === 'mc') {
    document.querySelectorAll('.mc-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const index = parseInt(opt.getAttribute('data-index'), 10);
        currentQ.selectedAnswerIndex = index;
        renderExamQuestion();
      });
    });
  }

  if (currentQ.type === 'oral') {
    const textarea = document.getElementById('exam-oral-textarea');
    if (textarea) {
      textarea.addEventListener('input', () => {
        currentQ.studentAnswer = textarea.value;
        const words = textarea.value.trim() === '' ? 0 : textarea.value.trim().split(/\s+/).length;
        const counter = document.getElementById('exam-word-counter-lbl');
        if (counter) counter.textContent = `Слов: ${words}`;
      });
    }
  }

  const btnPrev = document.getElementById('exam-prev-btn');
  const btnNext = document.getElementById('exam-next-btn');
  const btnFinish = document.getElementById('exam-finish-btn');

  if (btnPrev) {
    btnPrev.addEventListener('click', () => {
      if (exam.currentQuestionIndex > 0) {
        exam.currentQuestionIndex--;
        renderExamQuestion();
      }
    });
  }

  if (btnNext) {
    btnNext.addEventListener('click', () => {
      if (exam.currentQuestionIndex < exam.questions.length - 1) {
        exam.currentQuestionIndex++;
        renderExamQuestion();
      }
    });
  }

  if (btnFinish) {
    btnFinish.addEventListener('click', () => {
      if (confirm('Завершить экзамен и отправить ответы на проверку?')) {
        finishExam();
      }
    });
  }
}

function renderExamResults(attempt) {
  let gradeClass = 'grade-poor';
  let gradeText = 'Неудовлетворительно (2)';
  let desc = 'Вы не смогли свать экзамен. Рекомендуем еще раз повторить материал и карточки по темам.';
  
  if (attempt.grade === 'excellent') {
    gradeClass = 'grade-excellent';
    gradeText = 'Отлично (5)';
    desc = 'Великолепный результат! Ваш уровень знаний полностью готов для получения наивысшего балла на государственном экзамене.';
  } else if (attempt.grade === 'good') {
    gradeClass = 'grade-good';
    gradeText = 'Хорошо (4)';
    desc = 'Хорошая подготовка! Вы знаете основные концепции, но для наилучшего результата рекомендуется повторить пропущенные пункты.';
  } else if (attempt.grade === 'fair') {
    gradeClass = 'grade-fair';
    gradeText = 'Удовлетворительно (3)';
    desc = 'Нужно потренироваться. Вы получили средний балл, но в устных вопросах следовало более подробно раскрыть механизм работы.';
  }

  let correctMc = 0;
  let totalMc = 0;
  let oralEvaluationsHtml = '';

  state.activeExam.questions.forEach((q, idx) => {
    if (q.type === 'mc') {
      totalMc++;
      if (q.selectedAnswerIndex === q.correctIndex) correctMc++;
    } else if (q.type === 'oral') {
      const ev = q.evaluation;
      const oralGradeColor = ev.score >= 70 ? 'var(--success)' : (ev.score >= 50 ? 'var(--warning)' : 'var(--danger)');
      oralEvaluationsHtml += `
        <div style="margin-top:16px; padding:16px; background:var(--bg-primary); border-radius:var(--radius-md)">
          <div style="display:flex; justify-content:space-between; margin-bottom:8px">
            <span style="font-weight:700">${q.topicTitle}</span>
            <span style="font-weight:700; color:${oralGradeColor}">${ev.score} / 100 баллов</span>
          </div>
          <p style="font-size:0.85rem; line-height:1.4; color:var(--text-primary)">
            <strong>Оценка ИИ:</strong> ${ev.feedback}
          </p>
          ${ev.missing.length > 0 ? `
          <p style="font-size:0.8rem; color:var(--text-secondary); margin-top:6px">
            <strong>Следовало упомянуть:</strong> ${ev.missing.map(m => m.split('/')[0]).join(', ')}
          </p>` : ''}
        </div>`;
    }
  });

  appRoot.innerHTML = `
    <div class="exam-results-card glass">
      <div class="results-header">
        <span class="results-grade-badge ${gradeClass}">${gradeText}</span>
        <h2 style="font-family:var(--font-display); font-size:2.2rem; font-weight:800; margin-bottom:8px">${attempt.score}%</h2>
        <p style="color:var(--text-secondary); max-width:500px; margin: 0 auto; line-height:1.4">${desc}</p>
      </div>

      <div class="feedback-section">
        <h4 style="margin-bottom:12px; font-family:var(--font-display)">Показатели экзамена</h4>
        <div style="display:flex; justify-content:space-around; text-align:center">
          <div>
            <span style="font-size:0.75rem; color:var(--text-secondary); text-transform:uppercase">Вопросы теста</span>
            <p style="font-size:1.2rem; font-weight:700">${correctMc} / ${totalMc} верно</p>
          </div>
          <div style="width:1px; background:var(--border-color)"></div>
          <div>
            <span style="font-size:0.75rem; color:var(--text-secondary); text-transform:uppercase">Время экзамена</span>
            <p style="font-size:1.2rem; font-weight:700">${Math.floor((300 - state.activeExam.timeLeft) / 60)} минут</p>
          </div>
        </div>
      </div>

      <div>
        <h4 style="font-family:var(--font-display); font-size:1.1rem; margin-bottom:8px">Отчет ИИ-оценки по устным вопросам</h4>
        ${oralEvaluationsHtml}
      </div>

      <div style="margin-top:40px; text-align:center">
        <button class="btn btn-primary" id="exam-return-btn" style="padding:12px 30px">Вернуться на панель</button>
      </div>
    </div>`;

  state.activeExam = null;

  const returnBtn = document.getElementById('exam-return-btn');
  if (returnBtn) {
    returnBtn.addEventListener('click', () => {
      state.activeView = 'dashboard';
      renderActiveView();
    });
  }
}

// ==========================================================================
// ПЕРЕКЛЮЧАТЕЛЬ ТЕМЫ И МОБИЛЬНОЕ МЕНЮ
// ==========================================================================
function setupThemeSwitcher() {
  const btn = document.getElementById('theme-toggle');
  const sunIcon = btn.querySelector('.sun-icon');
  const moonIcon = btn.querySelector('.moon-icon');
  const label = btn.querySelector('.theme-toggle-label');

  const isDark = localStorage.getItem('theme_preference') === 'dark';
  if (isDark) {
    document.body.classList.add('dark-theme');
    sunIcon.style.display = 'none';
    moonIcon.style.display = 'block';
    if (label) label.textContent = 'Светлая тема';
  }

  btn.addEventListener('click', () => {
    const currentlyDark = document.body.classList.toggle('dark-theme');
    localStorage.setItem('theme_preference', currentlyDark ? 'dark' : 'light');
    
    if (currentlyDark) {
      sunIcon.style.display = 'none';
      moonIcon.style.display = 'block';
      if (label) label.textContent = 'Светлая тема';
    } else {
      sunIcon.style.display = 'block';
      moonIcon.style.display = 'none';
      if (label) label.textContent = 'Темная тема';
    }
  });
}

function setupMobileSidebar() {
  const btn = document.getElementById('mobile-menu-btn');
  const sidebar = document.querySelector('.sidebar');
  
  if (btn && sidebar) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      sidebar.classList.toggle('mobile-open');
    });

    document.addEventListener('click', (e) => {
      if (sidebar.classList.contains('mobile-open') && !sidebar.contains(e.target) && e.target !== btn) {
        sidebar.classList.remove('mobile-open');
      }
    });
  }
}

function navigate(viewName) {
  state.activeView = viewName;
  state.flashcardFlipped = false;
  renderActiveView();
  
  const sidebar = document.querySelector('.sidebar');
  if (sidebar) sidebar.classList.remove('mobile-open');
}

// ИНИЦИАЛИЗАЦИЯ ПРИЛОЖЕНИЯ
// ==========================================================================
document.addEventListener('DOMContentLoaded', async () => {
  const dateWidget = document.getElementById('header-date');
  if (dateWidget) {
    const today = new Date();
    const formattedDate = today.toLocaleDateString('ru-RU', {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    });
    dateWidget.textContent = formattedDate.charAt(0).toUpperCase() + formattedDate.slice(1);
  }

  loadState();

  // Инициализация кнопок переключения языка базы знаний
  const kgBtn = document.getElementById('lang-btn-kg');
  const ruBtn = document.getElementById('lang-btn-ru');
  
  function updateLangButtonsUI() {
    if (kgBtn && ruBtn) {
      if (state.dbLang === 'ru') {
        ruBtn.classList.add('active');
        kgBtn.classList.remove('active');
      } else {
        kgBtn.classList.add('active');
        ruBtn.classList.remove('active');
      }
    }
  }
  
  updateLangButtonsUI();

  if (kgBtn) {
    kgBtn.addEventListener('click', () => {
      if (state.dbLang !== 'kg') {
        state.dbLang = 'kg';
        updateLangButtonsUI();
        applyDbLanguage();
        saveState();
        renderActiveView();
      }
    });
  }

  if (ruBtn) {
    ruBtn.addEventListener('click', () => {
      if (state.dbLang !== 'ru') {
        state.dbLang = 'ru';
        updateLangButtonsUI();
        applyDbLanguage();
        saveState();
        renderActiveView();
      }
    });
  }

  const dataLoaded = await fetchExamData();
  
  if (dataLoaded) {
    renderActiveView();
    updateGlobalProgressUI();
  } else {
    appRoot.innerHTML = `
      <div class="loading-state" style="color:var(--danger)">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <p>Ошибка загрузки базы данных. Пожалуйста, проверьте файл "data/exam-data.js".</p>
      </div>`;
  }

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-target');
      navigate(target);
    });
  });

  const resetBtn = document.getElementById('reset-progress-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', resetProgress);
  }

  setupThemeSwitcher();
  setupMobileSidebar();
});

// 5. НАСТРОЙКИ ИИ (API DEEPSEEK)
function renderSettingsView() {
  document.getElementById('page-title').textContent = 'Настройки ИИ';

  appRoot.innerHTML = `
    <div class="settings-container glass">
      <h2 class="settings-title">Параметры ИИ-оценщика</h2>
      
      <!-- Выбор движка ИИ -->
      <div class="settings-group">
        <label class="settings-label">Движок анализа ответов</label>
        <span class="settings-desc">Выберите, каким образом будут проверяться ваши устные эссе на экзамене и в модулях обучения.</span>
        
        <div style="display:flex; flex-direction:column; gap:12px; margin-top:8px">
          <div class="settings-engine-option ${state.aiEngine === 'deepseek' ? 'active' : ''}" id="engine-opt-deepseek">
            <span class="radio-circle"></span>
            <div>
              <div style="font-weight:700">DeepSeek AI Grader (Рекомендуется)</div>
              <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:2px">Использует реальный интеллект Deepseek-Chat для глубокой проверки ответов, анализа контекста, поиска ошибок и формулирования развернутых советов. Требуется интернет-соединение.</div>
            </div>
          </div>
          
          <div class="settings-engine-option ${state.aiEngine === 'local' ? 'active' : ''}" id="engine-opt-local">
            <span class="radio-circle"></span>
            <div>
              <div style="font-weight:700">Локальный парсер (Оффлайн)</div>
              <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:2px">Быстрый поиск по ключевым словам и регулярным выражениям. Не требует интернета и API-ключа, но дает простую, механическую оценку.</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Ввод API Ключа -->
      <div class="settings-group" id="apikey-settings-section" style="${state.aiEngine === 'local' ? 'display:none' : ''}">
        <label class="settings-label">DeepSeek API Ключ</label>
        <span class="settings-desc">Для работы онлайн-оценщика необходим API-ключ. Мы предустановили предоставленный ключ разработчика, но вы можете заменить его на свой личный.</span>
        
        <div style="display:flex; gap:12px; margin-top:8px">
          <input type="password" id="settings-apikey-input" class="settings-input" placeholder="Введите ваш sk-..." value="${state.apiKey || ''}" />
          <button class="btn btn-secondary" id="toggle-key-visibility-btn" style="padding:0 15px">Показать</button>
        </div>
        
        <div style="display:flex; gap:12px; margin-top:10px">
          <button class="btn btn-primary" id="save-settings-btn" style="padding:10px 24px">Сохранить</button>
          <button class="btn btn-secondary" id="test-connection-btn">Проверить подключение</button>
          <button class="btn btn-danger" id="clear-apikey-btn" style="background:transparent; color:var(--danger); border:1px solid var(--danger)">Стереть ключ</button>
        </div>
        
        <div id="test-connection-status" style="margin-top:12px; font-size:0.9rem; font-weight:600; display:none"></div>

        <!-- Предупреждение о безопасности -->
        <div class="settings-warning">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <div>
            <strong>Внимание разработчикам:</strong> При деплое в публичный репозиторий GitHub Pages ваш API-ключ в исходном коде JS станет видимым для всех посетителей. Для полной конфиденциальности сотрите ключ кнопкой «Стереть ключ» и вводите его через эту панель настроек вашего браузера (ключ будет сохранен только в локальной памяти вашего браузера).
          </div>
        </div>
      </div>
    </div>
  `;

  // Переключение движков
  const optDeepseek = document.getElementById('engine-opt-deepseek');
  const optLocal = document.getElementById('engine-opt-local');
  const apikeySection = document.getElementById('apikey-settings-section');

  if (optDeepseek && optLocal && apikeySection) {
    optDeepseek.addEventListener('click', () => {
      state.aiEngine = 'deepseek';
      optDeepseek.classList.add('active');
      optLocal.classList.remove('active');
      apikeySection.style.display = 'block';
      saveState();
    });

    optLocal.addEventListener('click', () => {
      state.aiEngine = 'local';
      optLocal.classList.add('active');
      optDeepseek.classList.remove('active');
      apikeySection.style.display = 'none';
      saveState();
    });
  }

  // Видимость ключа
  const keyInput = document.getElementById('settings-apikey-input');
  const visBtn = document.getElementById('toggle-key-visibility-btn');
  if (visBtn && keyInput) {
    visBtn.addEventListener('click', () => {
      if (keyInput.type === 'password') {
        keyInput.type = 'text';
        visBtn.textContent = 'Скрыть';
      } else {
        keyInput.type = 'password';
        visBtn.textContent = 'Показать';
      }
    });
  }

  // Кнопки управления ключом
  const saveBtn = document.getElementById('save-settings-btn');
  const clearBtn = document.getElementById('clear-apikey-btn');
  const testBtn = document.getElementById('test-connection-btn');
  const statusDiv = document.getElementById('test-connection-status');

  if (saveBtn && keyInput) {
    saveBtn.addEventListener('click', () => {
      state.apiKey = keyInput.value.trim();
      saveState();
      alert('Настройки успешно сохранены!');
    });
  }

  if (clearBtn && keyInput) {
    clearBtn.addEventListener('click', () => {
      if (confirm('Стереть сохраненный API-ключ из локальной памяти браузера? ИИ-оценка вернется к локальному режиму.')) {
        state.apiKey = '';
        keyInput.value = '';
        saveState();
        alert('Ключ стерт из хранилища.');
      }
    });
  }

  if (testBtn && keyInput && statusDiv) {
    testBtn.addEventListener('click', async () => {
      const testingKey = keyInput.value.trim();
      if (!testingKey) {
        statusDiv.textContent = '⚠️ Введите API-ключ для проверки!';
        statusDiv.style.color = 'var(--warning)';
        statusDiv.style.display = 'block';
        return;
      }

      statusDiv.textContent = '⏳ Проверка соединения с DeepSeek API...';
      statusDiv.style.color = 'var(--text-secondary)';
      statusDiv.style.display = 'block';
      testBtn.disabled = true;

      try {
        const response = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${testingKey}`
          },
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [
              { role: 'user', content: 'Say OK' }
            ],
            max_tokens: 5
          })
        });

        if (response.ok) {
          statusDiv.textContent = '✅ Подключение установлено успешно! API-ключ активен и готов к работе.';
          statusDiv.style.color = 'var(--success)';
        } else {
          const errData = await response.json().catch(() => ({}));
          const errMsg = errData.error ? errData.error.message : `HTTP статус ${response.status}`;
          statusDiv.textContent = `❌ Ошибка проверки: ${errMsg}. Проверьте баланс и корректность ключа.`;
          statusDiv.style.color = 'var(--danger)';
        }
      } catch (err) {
        statusDiv.textContent = `❌ Ошибка сетевого соединения: ${err.message}`;
        statusDiv.style.color = 'var(--danger)';
      } finally {
        testBtn.disabled = false;
      }
    });
  }
}
