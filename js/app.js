// ===== ДАННЫЕ =====
let examData = null;

async function loadData() {
  try {
    const res = await fetch('data/exam_data.json');
    if (!res.ok) throw new Error('Не удалось загрузить данные');
    const raw = await res.json();
    examData = {};
    for (const [k, v] of Object.entries(raw)) {
      examData[Number(k)] = v;
    }
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

function showScreen(id) {
  ['start', 'tickets', 'quiz', 'result'].forEach(s => {
    document.getElementById('screen-' + s).classList.toggle('hidden', s !== id);
  });
  window.scrollTo(0, 0);
}

function goStart() {
  state = { ticket: null, current: 0, answers: [], plan: [], mode: null, review: false, browsingPast: false };
  closeExitModal();
  showScreen('start');
}

function exitQuiz() {
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

  document.getElementById('question-text').textContent = q.question;

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

(async () => {
  if (await loadData()) showScreen('start');
})();
