// ===== ДАННЫЕ =====
let examData = null;

// Формат data/exam_data.txt общий с Telegram-ботом (elecbot), описан в шапке самого файла.
// Разбор повторяет парсер бота (data.go), чтобы оба проекта читали файл одинаково:
//   # Билет N · ? вопрос · - неверный · + правильный · строка без маркера продолжает предыдущую
//   (с переносом строки), // комментарий, пустые строки игнорируются.
function parseExamData(text) {
  const tickets = {};
  const declared = new Set();
  let ticket = 0;
  let cur = null;

  const flush = () => {
    if (!cur) return;
    const b = cur;
    cur = null;
    const where = `строка ${b.line}: «${b.text.slice(0, 60)}»`;
    if (b.opts.length < 2) throw new Error(`${where} — меньше двух вариантов ответа`);
    if (b.correct.length === 0) throw new Error(`${where} — нет правильного ответа (нужна строка «+ »)`);
    if (b.correct.length > 1) throw new Error(`${where} — несколько правильных ответов (нужен ровно один «+ »)`);
    tickets[ticket].push({ question: b.text, options: b.opts, correct: b.correct[0] });
  };
  const isMarker = (s) => /^[?+-](\s|$)/.test(s);

  const lines = text.replace(/^\uFEFF/, '').split('\n');
  lines.forEach((rawLine, i) => {
    const lineNo = i + 1;
    const line = rawLine.trim();
    const at = (msg) => new Error(`exam_data.txt:${lineNo}: ${msg}`);

    if (line === '' || line.startsWith('//')) return;

    if (line.startsWith('#')) {
      flush();
      const m = /^#\s*билет\s+(\d+)$/i.exec(line);
      if (!m) throw at('ожидался заголовок вида «# Билет 3»');
      const n = Number(m[1]);
      if (n <= 0) throw at('номер билета должен быть больше нуля');
      if (declared.has(n)) throw at(`билет ${n} уже был объявлен`);
      declared.add(n);
      ticket = n;
      tickets[n] = [];
    } else if (line[0] === '?' && isMarker(line)) {
      if (!ticket) throw at('вопрос до первого заголовка «# Билет N»');
      flush();
      const t = line.slice(1).trim();
      if (!t) throw at('пустой вопрос');
      cur = { line: lineNo, text: t, opts: [], correct: [] };
    } else if (isMarker(line)) {
      if (!cur) throw at('вариант ответа без вопроса: перед ним нужна строка «? текст вопроса»');
      const t = line.slice(1).trim();
      if (!t) throw at('пустой вариант ответа');
      cur.opts.push(t);
      if (line[0] === '+') cur.correct.push(cur.opts.length - 1);
    } else {
      // строка без маркера продолжает предыдущую (с переносом строки)
      if (!cur) throw at('текст вне вопроса: строка без «?», «+», «-» должна продолжать вопрос или вариант');
      if (cur.opts.length === 0) cur.text += '\n' + line;
      else cur.opts[cur.opts.length - 1] += '\n' + line;
    }
  });
  flush();

  const nums = Object.keys(tickets).map(Number).sort((a, b) => a - b);
  if (!nums.length) throw new Error('в файле нет ни одного билета');
  nums.forEach((n, i) => {
    if (n !== i + 1) throw new Error(`номера билетов должны идти подряд: ожидался ${i + 1}, найден ${n}`);
    if (!tickets[n].length) throw new Error(`в билете ${n} нет вопросов`);
  });
  return tickets;
}

async function loadData() {
  try {
    const res = await fetch('data/exam_data.txt');
    if (!res.ok) throw new Error('Не удалось загрузить данные');
    examData = parseExamData(await res.text());
    return true;
  } catch (e) {
    console.error(e);
    document.body.innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;background:#0f172a;color:#e2e8f0;font-family:system-ui">
        <div style="text-align:center;max-width:360px">
          <p style="font-size:18px;margin-bottom:12px">⚠️ Не удалось загрузить вопросы</p>
          <p style="color:#94a3b8;font-size:14px;line-height:1.5">Обнови страницу или открой через сервер</p>
        </div>
      </div>`;
    return false;
  }
}

function qCount() {
  return state.ticket && examData[state.ticket] ? examData[state.ticket].length : 10;
}

// answers[i] = { options, correctIdx, chosen, isCorrect } | null
// plan[i]    = { options, correctIdx } — порядок вариантов, зафиксированный при старте билета
let state = {
  ticket: null,
  current: 0,
  answers: [],
  plan: [],
  mode: null,
  review: false,
  browsingPast: false
};
let lastRandomTicket = null;
let exitModalOpener = null;

function freshAnswers(n) {
  return Array(n).fill(null);
}

// История браузера: «Назад» (свайп / системная кнопка) не должен закрывать приложение.
// Главная — базовая запись; любой другой экран занимает ровно одну запись поверх неё.
let currentScreen = 'start';

function showScreen(id, fromHistory) {
  ['start', 'tickets', 'quiz', 'result', 'pin', 'search'].forEach(s => {
    const el = document.getElementById('screen-' + s);
    if (el) el.classList.toggle('hidden', s !== id);
  });
  currentScreen = id;
  window.scrollTo(0, 0);
  if (fromHistory) return;
  try {
    const cur = history.state && history.state.screen;
    if (id === 'start') {
      if (cur && cur !== 'start') history.back(); // вернёмся на базовую запись
    } else if (!cur || cur === 'start') {
      history.pushState({ screen: id }, '');
    } else {
      history.replaceState({ screen: id }, '');
    }
  } catch (e) {}
}

function quizInProgress() {
  return currentScreen === 'quiz' && !state.review && state.answers.some(a => a === null);
}

window.addEventListener('popstate', (e) => {
  const target = (e.state && e.state.screen) || 'start';
  if (target === currentScreen) return;
  if (quizInProgress()) {
    // вернули запись квиза на место и спросили подтверждение, а не вылетаем
    try { history.pushState({ screen: 'quiz' }, ''); } catch (err) {}
    exitQuiz();
    return;
  }
  goStart(true);
});

function goStart(fromHistory) {
  state = { ticket: null, current: 0, answers: [], plan: [], mode: null, review: false, browsingPast: false };
  closeExitModal();
  resetPin();
  showScreen('start', fromHistory === true);
  if (fromHistory === true) {
    try { history.replaceState({ screen: 'start' }, ''); } catch (err) {}
  }
}

function exitQuiz() {
  const modal = document.getElementById('exit-modal');
  if (modal && !modal.classList.contains('hidden')) return; // уже открыта
  exitModalOpener = document.activeElement;
  document.getElementById('exit-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  const stay = document.getElementById('exit-stay');
  if (stay) stay.focus();
}
function closeExitModal() {
  const m = document.getElementById('exit-modal');
  const wasOpen = m && !m.classList.contains('hidden');
  if (m) m.classList.add('hidden');
  document.body.style.overflow = '';
  if (wasOpen && exitModalOpener && document.contains(exitModalOpener)) exitModalOpener.focus();
  exitModalOpener = null;
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeExitModal();
});
function confirmExit() {
  closeExitModal();
  goStart();
}

// ===== БИЛЕТЫ =====
function showTickets() {
  const grid = document.getElementById('tickets-grid');
  grid.innerHTML = '';
  const tickets = Object.keys(examData).map(Number).sort((a, b) => a - b);
  for (const i of tickets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'py-4 rounded-2xl bg-slate-800 hover:bg-slate-700 border border-slate-700 flex items-center justify-center text-xl font-semibold active:scale-95 transition-all shadow-sm';
    btn.textContent = 'Билет ' + i;
    btn.onclick = () => startQuiz(i, 'choose');
    grid.appendChild(btn);
  }
  showScreen('tickets');
}

function startRandom() {
  let tickets = Object.keys(examData).map(Number);
  if (tickets.length > 1) tickets = tickets.filter(t => t !== lastRandomTicket);
  const ticket = tickets[Math.floor(Math.random() * tickets.length)];
  lastRandomTicket = ticket;
  startQuiz(ticket, 'random');
}

function startQuiz(ticket, mode) {
  const n = examData[ticket].length;
  state = {
    ticket,
    current: 0,
    answers: freshAnswers(n),
    plan: examData[ticket].map(q => buildOptions(q, true)),
    mode,
    review: false,
    browsingPast: false
  };
  showScreen('quiz');
  renderQuestion();
}

function startReview() {
  if (!state.answers.length || state.answers.some(a => a === null)) return;
  state.review = true;
  state.browsingPast = false;
  state.current = 0;
  showScreen('quiz');
  renderQuestion();
}

// ===== КУБИКИ =====
function firstUnanswered() {
  return state.answers.findIndex(a => a === null);
}

function renderDots() {
  const box = document.getElementById('quiz-dots');
  box.innerHTML = '';
  const n = qCount();
  const workIdx = firstUnanswered();

  for (let i = 0; i < n; i++) {
    const a = state.answers[i];
    const btn = document.createElement('button');
    btn.type = 'button';
    let cls = 'h-2.5 flex-1 rounded-sm transition-all min-w-0 ';

    if (a === null) {
      if (i === state.current) cls += 'bg-sky-500 ring-2 ring-sky-400/50';
      else if (i === workIdx) cls += 'bg-sky-700';
      else cls += 'bg-slate-700';
    } else if (a.isCorrect) {
      cls += i === state.current ? 'bg-emerald-400 ring-2 ring-emerald-300/50' : 'bg-emerald-500';
    } else {
      cls += i === state.current ? 'bg-red-400 ring-2 ring-red-300/50' : 'bg-red-500';
    }

    const canJump = state.review || a !== null || i === state.current || i === workIdx;
    if (canJump) {
      cls += ' dot-btn cursor-pointer active:scale-90';
      btn.onclick = () => jumpTo(i);
    } else {
      cls += ' opacity-40 cursor-default';
    }
    btn.className = cls;
    const status = a === null ? 'не отвечен' : a.isCorrect ? 'верно' : 'неверно';
    btn.title = 'Вопрос ' + (i + 1);
    btn.setAttribute('aria-label', 'Вопрос ' + (i + 1) + ', ' + status);
    if (i === state.current) btn.setAttribute('aria-current', 'step');
    box.appendChild(btn);
  }
}

function jumpTo(i) {
  const workIdx = firstUnanswered();
  if (!state.review && state.answers[i] === null && i !== state.current && i !== workIdx) return;
  // browsingPast только если реально ушли на другой (уже отвеченный) вопрос
  state.browsingPast = !state.review && state.answers[i] !== null && workIdx !== -1 && i !== workIdx && i !== state.current;
  state.current = i;
  const fromDot = document.activeElement && document.activeElement.closest && document.activeElement.closest('#quiz-dots');
  renderQuestion();
  // точки пересоздаются — возвращаем фокус на ту же точку
  if (fromDot) {
    const dot = document.getElementById('quiz-dots').children[i];
    if (dot) dot.focus({ preventScroll: true });
  }
}

// ===== ВОПРОС =====
const ICON_CHECK = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg>';
const ICON_CROSS = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 6l12 12M18 6L6 18"/></svg>';
function shuffleIndices(n) {
  const indices = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

// Варианты вида «Все ответы неверны», «Все перечисленные…» зависят от остальных —
// при перемешивании они остаются в конце (в исходном относительном порядке).
const PINNED_LAST = /все (ответы|вышеперечисленн|перечисленн|указанн)|всё перечисленное|во всех перечисленных|в любом из перечисленных/i;

function buildOptions(q, shuffle) {
  if (!shuffle) return { options: q.options.slice(), correctIdx: q.correct };
  const movable = [];
  const pinned = [];
  q.options.forEach((opt, i) => (PINNED_LAST.test(opt) ? pinned : movable).push(i));
  const order = shuffleIndices(movable.length).map(k => movable[k]).concat(pinned);
  return {
    options: order.map(i => q.options[i]),
    correctIdx: order.indexOf(q.correct)
  };
}

function renderQuestion() {
  const n = qCount();
  if (state.current < 0 || state.current >= n) state.current = 0;

  const q = examData[state.ticket][state.current];
  const saved = state.answers[state.current];
  const isLocked = saved !== null || state.review;

  document.getElementById('quiz-ticket').textContent =
    (state.review ? 'Просмотр · ' : '') + 'Билет ' + state.ticket;

  // «Вопрос 3 из 10» (цифры — textContent, без innerHTML)
  const prog = document.getElementById('quiz-progress');
  prog.textContent = '';
  prog.append('Вопрос ' + (state.current + 1) + ' ');
  const total = document.createElement('span');
  total.className = 'text-slate-400 font-medium';
  total.textContent = 'из ' + n;
  prog.appendChild(total);

  const shown = saved || state.plan[state.current];
  const options = shown.options;
  const correctIdx = shown.correctIdx;

  // новый вопрос открываем с начала страницы (иначе остаётся прокрутка от предыдущего)
  const view = state.ticket + ':' + state.current + ':' + state.review;
  const viewChanged = view !== state._view;
  state._view = view;
  if (viewChanged) window.scrollTo(0, 0);

  const qEl = document.getElementById('question-text');
  qEl.textContent = q.question;
  qEl.style.whiteSpace = 'pre-line'; // переносы строк из exam_data.txt

  const list = document.getElementById('options-list');
  list.innerHTML = '';
  options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    let cls = 'option-btn w-full text-left py-4 px-4 rounded-2xl border transition-all flex items-center ';
    if (isLocked) {
      cls += 'cursor-default ';
      if (i === correctIdx) cls += 'bg-emerald-900/50 border-emerald-500/60 ';
      else if (saved && i === saved.chosen && !saved.isCorrect) cls += 'bg-red-900/40 border-red-500/50 ';
      else cls += 'bg-slate-800/50 border-slate-700 opacity-50 ';
    } else {
      cls += 'bg-slate-800/80 hover:bg-slate-700 border-slate-700 active:scale-[0.98] ';
    }
    btn.className = cls;

    // Верно/неверно — не только цветом: значок в «номерке» + подпись для скринридера
    const isRight = isLocked && i === correctIdx;
    const isWrongPick = !!saved && i === saved.chosen && !saved.isCorrect;
    const num = document.createElement('span');
    num.className = 'inline-flex items-center justify-center w-7 h-7 rounded-lg text-sm font-medium mr-3 shrink-0 ' +
      (isRight ? 'bg-emerald-600 text-white' : isWrongPick ? 'bg-red-600 text-white' : 'bg-slate-700');
    if (isRight) num.innerHTML = ICON_CHECK;
    else if (isWrongPick) num.innerHTML = ICON_CROSS;
    else num.textContent = String(i + 1);
    if (isLocked) {
      btn.disabled = true;
      let note = '';
      if (isRight) note = saved && saved.chosen === i ? '. Верно, это ваш ответ' : '. Правильный ответ';
      else if (isWrongPick) note = '. Ваш ответ, неверно';
      btn.setAttribute('aria-label', (i + 1) + '. ' + opt + note);
    }

    const text = document.createElement('span');
    text.className = 'text-[15px] leading-snug';
    text.textContent = opt;
    text.style.whiteSpace = 'pre-line';

    btn.appendChild(num);
    btn.appendChild(text);
    if (!isLocked) btn.onclick = () => selectAnswer(i);
    list.appendChild(btn);
  });

  renderDots();
  updateNav();
}

function selectAnswer(chosen) {
  if (state.answers[state.current] !== null || state.review) return;

  const { options, correctIdx } = state.plan[state.current];
  state.answers[state.current] = {
    options,
    correctIdx,
    chosen,
    isCorrect: chosen === correctIdx
  };
  state.browsingPast = false;
  renderQuestion();
  const fb = document.getElementById('feedback');
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // фокус на «Следующий вопрос» — иначе после перерисовки вариантов он теряется (важно для клавиатуры)
  const nb = document.getElementById('btn-next');
  if (nb && !nb.classList.contains('hidden')) nb.focus({ preventScroll: true });
  if (fb) fb.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
}

function updateNav() {
  const fb = document.getElementById('feedback');
  const nextBtn = document.getElementById('btn-next');
  const reviewNav = document.getElementById('review-nav');
  const prevBtn = document.getElementById('btn-prev');
  const toResultBtn = document.getElementById('btn-to-result');
  const reviewNextBtn = document.getElementById('btn-review-next');

  const n = qCount();
  const answered = state.answers[state.current] !== null;
  const workIdx = firstUnanswered();
  const allDone = workIdx === -1;

  if (state.review) {
    fb.classList.remove('hidden');
    nextBtn.classList.add('hidden');
    reviewNav.classList.remove('hidden');

    prevBtn.disabled = state.current === 0;
    prevBtn.classList.toggle('opacity-30', state.current === 0);
    reviewNextBtn.disabled = state.current >= n - 1;
    reviewNextBtn.classList.toggle('opacity-30', state.current >= n - 1);

    prevBtn.onclick = () => {
      if (state.current > 0) {
        state.current--;
        renderQuestion();
      }
    };
    reviewNextBtn.onclick = () => {
      if (state.current < n - 1) {
        state.current++;
        renderQuestion();
      }
    };
    toResultBtn.onclick = () => {
      state.review = false;
      showResult();
    };
    return;
  }

  reviewNav.classList.add('hidden');
  nextBtn.classList.remove('hidden');

  if (!answered) {
    fb.classList.add('hidden');
    return;
  }

  fb.classList.remove('hidden');

  if (allDone) {
    nextBtn.textContent = 'Посмотреть результат →';
    nextBtn.onclick = () => {
      state.browsingPast = false;
      showResult();
    };
    return;
  }

  if (state.browsingPast) {
    nextBtn.textContent = 'К текущему →';
    nextBtn.onclick = () => {
      state.browsingPast = false;
      state.current = workIdx;
      renderQuestion();
    };
    return;
  }

  let nextIdx = -1;
  for (let i = state.current + 1; i < n; i++) {
    if (state.answers[i] === null) { nextIdx = i; break; }
  }
  if (nextIdx === -1) nextIdx = workIdx;

  nextBtn.textContent = 'Следующий вопрос →';
  nextBtn.onclick = () => {
    state.browsingPast = false;
    state.current = nextIdx;
    renderQuestion();
  };
}

// ===== РЕЗУЛЬТАТ =====
function showResult() {
  state.review = false;
  state.browsingPast = false;
  const n = state.answers.length || 10;
  const correct = state.answers.filter(a => a && a.isCorrect).length;
  const percent = n ? Math.round((correct / n) * 100) : 0;

  document.getElementById('result-ticket').textContent = 'Билет ' + state.ticket;
  document.getElementById('result-score').textContent = correct + '/' + n;
  document.getElementById('result-percent').textContent = percent + '%';

  const icon = document.getElementById('result-icon');
  const msg = document.getElementById('result-message');
  const pctEl = document.getElementById('result-percent');

  if (percent >= 80) {
    icon.className = 'w-24 h-24 rounded-full flex items-center justify-center mb-6 animate-scale-in bg-emerald-500/20 text-emerald-400';
    icon.innerHTML = '<svg class="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>';
    msg.textContent = 'Отлично! Готов к аттестации! 😎';
    pctEl.className = 'text-2xl font-semibold text-emerald-400 mb-4';
  } else if (percent >= 60) {
    icon.className = 'w-24 h-24 rounded-full flex items-center justify-center mb-6 animate-scale-in bg-amber-500/20 text-amber-400';
    icon.innerHTML = '<svg class="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>';
    msg.textContent = 'Хорошо, но могло быть и лучше 🙃';
    pctEl.className = 'text-2xl font-semibold text-amber-400 mb-4';
  } else {
    icon.className = 'w-24 h-24 rounded-full flex items-center justify-center mb-6 animate-scale-in bg-red-500/20 text-red-400';
    icon.innerHTML = '<svg class="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>';
    msg.textContent = 'Нужно подучить 🤓';
    pctEl.className = 'text-2xl font-semibold text-red-400 mb-4';
  }

  showScreen('result');
}

// ===== СЕКРЕТНЫЙ ВХОД + ПОИСК (как в боте) =====
// PIN хранится как SHA-256 от (соль + PIN). Это скрывает код от беглого взгляда в исходники,
// но не защита: 4 цифры подбираются мгновенно. Чтобы сменить PIN, см. README.
// Нужен защищённый контекст (https / localhost) — на GitHub Pages он есть.
const PIN_SALT = 'eq:v1:';
const PIN_HASH = 'f6489ea2bfdf1e7b4b35845bae9a1ec0755f153a458af7c38860679f669a18e4';
const SEARCH_LIMIT = 5;
const SECRET_TAPS_NEEDED = 5;

let secretTapCount = 0;
let secretTapTimer = null;
let pinValue = '';
let searchIndex = null;
let searchShowAll = false;
let pinChecking = false;

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function pinIsValid(pin) {
  try {
    return (await sha256Hex(PIN_SALT + pin)) === PIN_HASH;
  } catch (e) {
    return false;
  }
}

function buzz(ms) {
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
}

const HOMOGLYPHS = {
  'а': 'a', 'с': 'c', 'е': 'e', 'о': 'o', 'р': 'p', 'х': 'x',
  'у': 'y', 'к': 'k', 'м': 'm', 'н': 'h', 'т': 't', 'в': 'b'
};

function norm(s) {
  return String(s).toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[асеорхукмнтв]/g, ch => HOMOGLYPHS[ch] || ch);
}

function stem(word) {
  if (word.length <= 4) return word;
  return word.slice(0, Math.max(4, Math.min(6, word.length - 2)));
}

function buildSearchIndex() {
  if (!examData) return [];
  const unique = new Map();
  for (const [ticketStr, questions] of Object.entries(examData)) {
    const ticket = Number(ticketStr);
    questions.forEach((q, idx) => {
      const correctText = q.options[q.correct];
      const key = norm(q.question) + '\0' + norm(correctText);
      if (!unique.has(key)) {
        unique.set(key, {
          question: q.question,
          correct: correctText,
          q_norm: norm(q.question),
          o_norm: norm(q.options.join(' ')),
          places: []
        });
      }
      unique.get(key).places.push([ticket, idx + 1]);
    });
  }
  return Array.from(unique.values());
}

// Как Python \w: буквы (в т.ч. кириллица) + цифры + _
const WORD_RE = /[\p{L}\p{N}_]+/gu;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

// Границы совпадения для коротких стемов:
//  1–2 буквы — только целое слово (аббревиатуры: «ВЛ», «ЛЭП»);
//  3 буквы — с начала слова («ток» → «тока», «током»);
//  4+ — любая подстрока.
function matchAt(s, text, i) {
  if (s.length > 3) return true;
  const before = i === 0 || !WORD_CHAR.test(text[i - 1]);
  const after = s.length === 3 || i + s.length >= text.length || !WORD_CHAR.test(text[i + s.length]);
  return before && after;
}

function findMatches(s, text, firstOnly) {
  const out = [];
  let from = 0;
  while (from <= text.length) {
    const i = text.indexOf(s, from);
    if (i === -1) break;
    if (matchAt(s, text, i)) {
      out.push(i);
      if (firstOnly) break;
    }
    from = i + 1;
  }
  return out;
}

function queryStems(query) {
  // как в боте: re.findall(r'\w+', norm(query)) + len > 1 + stem
  return (norm(query).match(WORD_RE) || [])
    .filter(w => w.length > 1)
    .map(stem);
}

function searchQuestions(query, limit) {
  if (!searchIndex) searchIndex = buildSearchIndex();
  const stems = queryStems(query);
  if (!stems.length) return { results: [], total: 0, stems };

  const has = (s, text) => findMatches(s, text, true).length > 0;

  const scored = [];
  for (const item of searchIndex) {
    let score = 0;
    for (const s of stems) {
      if (has(s, item.q_norm)) score += 2;
      else if (has(s, item.o_norm)) score += 1;
    }
    if (score) scored.push({ score, item });
  }
  if (!scored.length) return { results: [], total: 0, stems };

  const best = Math.max(...scored.map(x => x.score));
  const top = scored.filter(x => x.score === best).map(x => x.item);
  return { results: top.slice(0, limit === undefined ? SEARCH_LIMIT : limit), total: top.length, stems };
}

// Подсветка найденных слов целиком. Нормализация не меняет длину строки,
// поэтому позиции из нормализованного текста подходят к исходному.
function highlight(text, stems) {
  const n = norm(text);
  if (n.length !== text.length) return escapeHtml(text);
  const marks = [];
  for (const s of stems) {
    for (const i of findMatches(s, n, false)) {
      let end = i + s.length;
      while (end < n.length && WORD_CHAR.test(n[end])) end++;
      marks.push([i, end]);
    }
  }
  if (!marks.length) return escapeHtml(text);
  marks.sort((a, b) => a[0] - b[0]);
  const merged = [marks[0].slice()];
  for (let k = 1; k < marks.length; k++) {
    const last = merged[merged.length - 1];
    if (marks[k][0] <= last[1]) last[1] = Math.max(last[1], marks[k][1]);
    else merged.push(marks[k].slice());
  }
  let html = '';
  let pos = 0;
  for (const [a, b] of merged) {
    html += escapeHtml(text.slice(pos, a)) + '<mark>' + escapeHtml(text.slice(a, b)) + '</mark>';
    pos = b;
  }
  return html + escapeHtml(text.slice(pos));
}

function formatPlaces(places) {
  const byTicket = {};
  for (const [t, num] of places) {
    if (!byTicket[t]) byTicket[t] = [];
    byTicket[t].push(num);
  }
  return Object.keys(byTicket).sort((a, b) => a - b)
    .map(t => `Билет ${t}, вопрос ${byTicket[t].join(', ')}`)
    .join('; ');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- PIN ---
function resetPin() {
  pinValue = '';
  pinChecking = false;
  const dots = document.querySelectorAll('#pin-dots .pin-dot');
  dots.forEach(d => d.classList.remove('filled', 'error'));
}

function updatePinDots() {
  const dots = document.querySelectorAll('#pin-dots .pin-dot');
  dots.forEach((d, i) => {
    d.classList.remove('error');
    d.classList.toggle('filled', i < pinValue.length);
  });
}

function showPinError() {
  const dots = document.querySelectorAll('#pin-dots .pin-dot');
  dots.forEach(d => {
    d.classList.remove('filled');
    d.classList.add('error');
  });
  buzz(60);
  setTimeout(() => {
    pinChecking = false;
    pinValue = '';
    resetPin();
  }, 400);
}

function pinScreenOpen() {
  const el = document.getElementById('screen-pin');
  return !!el && !el.classList.contains('hidden');
}

function onPinDigit(digit) {
  if (pinChecking || pinValue.length >= 4) return;
  pinValue += digit;
  buzz(8);
  updatePinDots();
  if (pinValue.length === 4) {
    pinChecking = true;
    pinIsValid(pinValue).then(ok => {
      if (!pinScreenOpen()) { pinChecking = false; return; } // ушли с экрана, пока считался хеш
      if (ok) {
        setTimeout(() => {
          pinChecking = false;
          resetPin();
          openSearch();
        }, 150);
      } else {
        showPinError();
      }
    });
  }
}

function onPinBackspace() {
  if (pinChecking || !pinValue.length) return;
  pinValue = pinValue.slice(0, -1);
  updatePinDots();
}

function openPinScreen() {
  resetPin();
  showScreen('pin');
}

// --- секретные тапы ---
function onSecretTap() {
  secretTapCount++;
  if (secretTapTimer) clearTimeout(secretTapTimer);
  secretTapTimer = setTimeout(() => { secretTapCount = 0; }, 2500);
  if (secretTapCount >= SECRET_TAPS_NEEDED) {
    secretTapCount = 0;
    openPinScreen();
  }
}

// --- поиск UI ---
function openSearch() {
  searchShowAll = false;
  showScreen('search');
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');
  const meta = document.getElementById('search-meta');
  if (meta) meta.textContent = '';
  if (results) {
    results.innerHTML = '<p class="search-empty">Введи часть вопроса или ответа</p>';
  }
  if (input) {
    input.value = '';
    // На телефоне автофокус сразу открывает клавиатуру и прячет подсказку —
    // фокусируем только на устройствах с мышью/тачпадом.
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (!coarse) setTimeout(() => input.focus(), 100);
  }
}

function renderSearchResults(query) {
  const box = document.getElementById('search-results');
  const meta = document.getElementById('search-meta');
  if (!box) return;

  const q = (query || '').trim();
  if (!q) {
    if (meta) meta.textContent = '';
    box.innerHTML = '<p class="search-empty">Введи часть вопроса или ответа</p>';
    return;
  }

  const { results, total, stems } = searchQuestions(q, searchShowAll ? Infinity : SEARCH_LIMIT);
  if (!results.length) {
    if (meta) meta.textContent = '';
    box.innerHTML = '<p class="search-empty">Ничего не найдено</p>';
    return;
  }

  if (meta) {
    meta.textContent = total > results.length
      ? `Показано ${results.length} из ${total}`
      : (total === 1 ? '1 совпадение' : `Совпадений: ${total}`);
  }

  let html = results.map(item => `
    <article class="search-card">
      <span class="search-places">${escapeHtml(formatPlaces(item.places))}</span>
      <p class="search-q">${highlight(item.question, stems)}</p>
      <p class="search-a">${highlight(item.correct, stems)}</p>
    </article>
  `).join('');

  if (total > results.length) {
    html += `<button type="button" id="search-show-all" class="search-more-btn">Показать все (${total})</button>`;
  }
  box.innerHTML = html;

  const more = document.getElementById('search-show-all');
  if (more) {
    more.addEventListener('click', () => {
      searchShowAll = true;
      renderSearchResults(query);
    });
  }
}

function initSecretAndSearch() {
  const zone = document.getElementById('secret-tap-zone');
  if (zone) {
    zone.addEventListener('click', onSecretTap);
    // без pointer-events на img, чтобы клики шли в зону
  }

  document.querySelectorAll('.pin-key').forEach(btn => {
    btn.addEventListener('click', () => onPinDigit(btn.dataset.digit));
  });
  const back = document.getElementById('pin-backspace');
  if (back) back.addEventListener('click', onPinBackspace);

  // клавиатура на PIN-экране
  document.addEventListener('keydown', (e) => {
    if (!pinScreenOpen()) return;
    if (e.key >= '0' && e.key <= '9') {
      e.preventDefault();
      onPinDigit(e.key);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      onPinBackspace();
    } else if (e.key === 'Escape') {
      goStart();
    }
  });

  const input = document.getElementById('search-input');
  if (input) {
    let debounce = null;
    input.addEventListener('input', () => {
      searchShowAll = false;
      clearTimeout(debounce);
      debounce = setTimeout(() => renderSearchResults(input.value), 180);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') goStart();
    });
  }
}

(async () => {
  if (await loadData()) {
    searchIndex = buildSearchIndex();
    try { history.replaceState({ screen: 'start' }, ''); } catch (e) {}
    showScreen('start', true);
    initSecretAndSearch();
  }
})();
