// Config
const START_MIN = 8 * 60;   // 08:00
const END_MIN = 22 * 60;    // 22:00
const SLOT_MIN = 10;        // 10-minute slots
const ROWS = (END_MIN - START_MIN) / SLOT_MIN;

// State
const occupancy = Array.from({ length: 7 }, () => Array(ROWS).fill(false));
let events = []; // {id, type: 'task'|'course', title, day, startSlot, slots}
let todos = [];  // {title, duration}
let slotH = 28; // px per slot (vertical zoom)
let nextId = 1;

// DOM refs
const grid = document.getElementById('grid');
const todoForm = document.getElementById('todo-form');
const todoList = document.getElementById('todo-list');
const taskTemplate = document.getElementById('task-template');
const courseForm = document.getElementById('course-form');

// Utils
let storageWarningShown = false;
const API_BASE = '';
function showStorageWarning(message = '無法儲存資料，請確認未在無痕模式或未封鎖儲存。') {
  if (storageWarningShown) return;
  storageWarningShown = true;
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:9999;background:#ffeded;color:#b00020;padding:8px 12px;font-size:14px;border-bottom:1px solid #f0c0c0;';
  bar.textContent = message;
  const btn = document.createElement('button');
  btn.textContent = '我知道了';
  btn.style.cssText = 'margin-left:12px;background:#b00020;color:white;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;';
  btn.addEventListener('click', () => bar.remove());
  bar.appendChild(btn);
  document.body.appendChild(bar);
}

async function requestPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      if (!already) await navigator.storage.persist();
    }
  } catch {}
}
function minutesToLabel(minsFromMidnight) {
  const h = Math.floor(minsFromMidnight / 60).toString().padStart(2, '0');
  const m = (minsFromMidnight % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function durationToSlots(mins) { return Math.ceil(mins / SLOT_MIN); }

function cellIndex(day, slot) {
  const colWidth = (grid.clientWidth - 60) / 7; // exclude time column
  const rowHeight = parseFloat(getComputedStyle(grid).gridAutoRows);
  const left = 60 + day * colWidth;
  const top = slot * rowHeight;
  return { left, top, colWidth, rowHeight };
}
function getIndicesFromPointer(clientX, clientY) {
  const rect = grid.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const innerX = x - 60; // after time column
  if (innerX < 0) return null;
  const colWidth = (grid.clientWidth - 60) / 7;
  const rowHeight = parseFloat(getComputedStyle(grid).gridAutoRows);
  const day = Math.floor(innerX / colWidth);
  const slot = Math.floor(y / rowHeight);
  if (day < 0 || day > 6 || slot < 0 || slot >= ROWS) return null;
  return { day, slot };
}

function createGrid() {
  const slotsPerHour = 60 / SLOT_MIN; // 6 when SLOT_MIN=10
  for (let r = 0; r < ROWS; r++) {
    const t = START_MIN + r * SLOT_MIN;
    const timeCell = document.createElement('div');
    timeCell.className = 'time-cell time-col';
    timeCell.textContent = (r % slotsPerHour === 0) ? minutesToLabel(t) : '';
    grid.appendChild(timeCell);
    for (let d = 0; d < 7; d++) {
      const slotCell = document.createElement('div');
      slotCell.className = 'slot-cell';
      slotCell.dataset.day = String(d);
      slotCell.dataset.slot = String(r);
      grid.appendChild(slotCell);
    }
  }
}

function clearHighlights() {
  grid.querySelectorAll('.highlight-valid, .highlight-invalid')
    .forEach(el => el.classList.remove('highlight-valid', 'highlight-invalid'));
}

function canPlace(day, startSlot, neededSlots, ignoreRange) {
  if (startSlot < 0 || startSlot + neededSlots > ROWS) return false;
  for (let i = 0; i < neededSlots; i++) {
    const idx = startSlot + i;
    let occ = occupancy[day][idx];
    if (ignoreRange && ignoreRange.day === day && idx >= ignoreRange.start && idx < ignoreRange.end) occ = false;
    if (occ) return false;
  }
  return true;
}

function highlightRange(day, startSlot, neededSlots, valid) {
  for (let i = 0; i < neededSlots; i++) {
    const slot = startSlot + i;
    if (slot < 0 || slot >= ROWS) continue;
    const cell = grid.querySelector(`.slot-cell[data-day='${day}'][data-slot='${slot}']`);
    if (!cell) continue;
    cell.classList.add(valid ? 'highlight-valid' : 'highlight-invalid');
  }
}

function occupyRange(day, startSlot, slots, value = true) {
  for (let i = 0; i < slots; i++) occupancy[day][startSlot + i] = value;
}

function findEventById(id) { return events.find(e => e.id === id); }
function removeEventById(id) { const i = events.findIndex(e => e.id === id); if (i !== -1) events.splice(i,1); }
async function apiLoadState() {
  try {
    const res = await fetch(`${API_BASE}/api/state`, { cache: 'no-store' });
    if (res.status === 204) return null;
    if (!res.ok) return null;
    const data = await res.json();
    return data;
  } catch {
    return null;
  }
}

async function apiSaveState(state) {
  try {
    await fetch(`${API_BASE}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });
  } catch {
    // ignore; localStorage remains as fallback
  }
}

function saveState() {
  const state = { version: 1, nextId, events, todos, ui: { slotH } };
  try { localStorage.setItem('scheduleState', JSON.stringify(state)); }
  catch {
    showStorageWarning();
  }
  // also push to backend if可用（若請求失敗就忽略）
  apiSaveState(state);
}
async function loadState() {
  let state = null;
  // 先嘗試後端
  state = await apiLoadState();
  // 後端沒有或失敗，再用 localStorage
  if (!state) {
    try { state = JSON.parse(localStorage.getItem('scheduleState') || 'null'); } catch {}
  }
  if (!state || !state.version) return false;
  if (state.ui && typeof state.ui.slotH === 'number') {
    slotH = state.ui.slotH;
    applySlotHeight(slotH);
  }
  // reset
  for (let d = 0; d < 7; d++) occupancy[d].fill(false);
  grid.querySelectorAll('.event').forEach(el => el.remove());
  todoList.innerHTML = '';
  // restore
  events = state.events || [];
  todos = state.todos || [];
  nextId = state.nextId || (Math.max(0, ...events.map(e=>e.id||0)) + 1);
  for (const ev of events) {
    occupyRange(ev.day, ev.startSlot, ev.slots, true);
    renderEvent(ev);
  }
  for (const t of todos) addTodoItem(t.title, t.duration, false);
  // sync the slider if present
  const rng = document.getElementById('slotHRange');
  if (rng) rng.value = String(slotH);
  return true;
}

function applySlotHeight(px) {
  slotH = clamp(px, 12, 80);
  const schedule = document.querySelector('.schedule');
  if (schedule) schedule.style.setProperty('--slot-h', `${slotH}px`);
  // reposition existing events to match new row height
  document.querySelectorAll('.event').forEach(el => positionEventEl(el));
}

function positionEventEl(el) {
  const day = parseInt(el.dataset.day, 10);
  const startSlot = parseInt(el.dataset.start, 10);
  const slots = parseInt(el.dataset.slots, 10);
  const { left, top, colWidth, rowHeight } = cellIndex(day, startSlot);
  el.style.left = `${left + 2}px`;
  el.style.top = `${top + 2}px`;
  el.style.width = `${colWidth - 4}px`;
  el.style.height = `${rowHeight * slots - 4}px`;
}
function updateEventTimeLabel(el) {
  const startSlot = parseInt(el.dataset.start, 10);
  const slots = parseInt(el.dataset.slots, 10);
  const startMin = START_MIN + startSlot * SLOT_MIN;
  const endMin = startMin + slots * SLOT_MIN;
  const durationEl = el.querySelector('.duration');
  if (durationEl) durationEl.textContent = `${minutesToLabel(startMin)} - ${minutesToLabel(endMin)}`;
}

function bindEventInteractions(el) {
  const type = el.dataset.type;
  const slots = parseInt(el.dataset.slots, 10);
  const title = el.dataset.title;
  const id = parseInt(el.dataset.id || '0', 10) || null;
  if (type === 'task') {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      const day = parseInt(el.dataset.day, 10);
      const start = parseInt(el.dataset.start, 10);
      draggingTask = {
        title,
        durationMin: slots * SLOT_MIN,
        slots,
        fromEvent: true,
        eventEl: el,
        fromRange: { day, start, end: start + slots }
      };
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => { clearHighlights(); draggingTask = null; });
    const btnReturn = el.querySelector('.btn-return');
    if (btnReturn) btnReturn.addEventListener('click', () => {
      const day = parseInt(el.dataset.day, 10);
      const start = parseInt(el.dataset.start, 10);
      occupyRange(day, start, slots, false);
      addTodoItem(title, slots * SLOT_MIN);
      if (id) removeEventById(id);
      saveState();
      el.remove();
    });
  } else if (type === 'course') {
    const btnDelete = el.querySelector('.btn-delete');
    if (btnDelete) btnDelete.addEventListener('click', () => {
      const day = parseInt(el.dataset.day, 10);
      const start = parseInt(el.dataset.start, 10);
      occupyRange(day, start, slots, false);
      if (id) removeEventById(id);
      saveState();
      el.remove();
    });
  }
}

function renderEvent({ id, day, startSlot, slots, title, type }) {
  const el = document.createElement('div');
  el.className = `event ${type}`;
  el.dataset.type = type;
  el.dataset.day = String(day);
  el.dataset.start = String(startSlot);
  el.dataset.slots = String(slots);
  el.dataset.title = title;
  if (id != null) el.dataset.id = String(id);
  const startMin = START_MIN + startSlot * SLOT_MIN;
  const endMin = startMin + slots * SLOT_MIN;
  const actions = [];
  if (type === 'task') actions.push('<button class="btn btn-return" title="撤回到TODO">↩︎</button>');
  if (type === 'course') actions.push('<button class="btn btn-delete" title="刪除行程">×</button>');
  el.innerHTML = `
    <div class="title">${title}</div>
    <div class="duration">${minutesToLabel(startMin)} - ${minutesToLabel(endMin)}</div>
    <div class="actions">${actions.join('')}</div>
  `;
  if (type === 'task') {
    const h = document.createElement('div');
    h.className = 'resize-handle';
    el.appendChild(h);
  }
  grid.appendChild(el);
  positionEventEl(el);
  bindEventInteractions(el);
  return el;
}

function addEventBlock({ day, startSlot, slots, title, type }) {
  const ev = { id: nextId++, type, title, day, startSlot, slots };
  events.push(ev);
  const el = renderEvent(ev);
  saveState();
  return el;
}

// Drag-and-drop
let draggingTask = null; // {title, durationMin, slots, sourceEl?, fromEvent?, eventEl?, fromRange?}
function setupGridDnD() {
  grid.addEventListener('dragover', (e) => {
    if (!draggingTask) return;
    e.preventDefault();
    clearHighlights();
    const info = getIndicesFromPointer(e.clientX, e.clientY);
    if (!info) return;
    const { day, slot } = info;
    const ok = canPlace(day, slot, draggingTask.slots, draggingTask.fromRange);
    highlightRange(day, slot, draggingTask.slots, ok);
  });
  grid.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && grid.contains(e.relatedTarget)) return;
    clearHighlights();
  });
  grid.addEventListener('drop', (e) => {
    if (!draggingTask) return;
    e.preventDefault();
    const info = getIndicesFromPointer(e.clientX, e.clientY);
    clearHighlights();
    if (!info) { draggingTask = null; return; }
    const { day, slot } = info;
    const ok = canPlace(day, slot, draggingTask.slots, draggingTask.fromRange);
    if (!ok) { draggingTask = null; return; }

    if (draggingTask.fromEvent && draggingTask.eventEl) {
      const oldDay = parseInt(draggingTask.eventEl.dataset.day, 10);
      const oldStart = parseInt(draggingTask.eventEl.dataset.start, 10);
      occupyRange(oldDay, oldStart, draggingTask.slots, false);
      occupyRange(day, slot, draggingTask.slots, true);
      draggingTask.eventEl.dataset.day = String(day);
      draggingTask.eventEl.dataset.start = String(slot);
      positionEventEl(draggingTask.eventEl);
      updateEventTimeLabel(draggingTask.eventEl);
      const id = parseInt(draggingTask.eventEl.dataset.id || '0', 10);
      const ev = findEventById(id);
      if (ev) { ev.day = day; ev.startSlot = slot; saveState(); }
    } else {
      occupyRange(day, slot, draggingTask.slots, true);
      addEventBlock({ day, startSlot: slot, slots: draggingTask.slots, title: draggingTask.title, type: 'task' });
      if (draggingTask.sourceEl && draggingTask.sourceEl.parentElement === todoList) {
        draggingTask.sourceEl.remove();
        const idx = todos.findIndex(t => t.title === draggingTask.title && t.duration === draggingTask.slots * SLOT_MIN);
        if (idx !== -1) { todos.splice(idx,1); saveState(); }
      }
    }
    draggingTask = null;
  });
}

function makeTaskDraggable(el, title, durationMin) {
  const slots = durationToSlots(durationMin);
  el.setAttribute('draggable', 'true');
  el.addEventListener('dragstart', (e) => {
    draggingTask = { title, durationMin, slots, sourceEl: el };
    e.dataTransfer.effectAllowed = 'copyMove';
  });
  el.addEventListener('dragend', () => { clearHighlights(); draggingTask = null; });
}

function addTodoItem(title, durationMin, track = true) {
  const node = taskTemplate.content.firstElementChild.cloneNode(true);
  node.innerHTML = `<div>${title}</div><div class="meta">${durationMin} 分鐘</div>`;
  makeTaskDraggable(node, title, durationMin);
  todoList.appendChild(node);
  if (track) { todos.push({ title, duration: durationMin }); saveState(); }
}

// Forms
todoForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = document.getElementById('todo-title').value.trim();
  const duration = parseInt(document.getElementById('todo-duration').value, 10);
  if (!title || !duration) return;
  addTodoItem(title, duration);
  todoForm.reset();
  document.getElementById('todo-duration').value = 60;
});

courseForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = document.getElementById('course-title').value.trim();
  const day = parseInt(document.getElementById('course-day').value, 10);
  const start = document.getElementById('course-start').value || '08:00';
  const duration = parseInt(document.getElementById('course-duration').value, 10) || 60;

  const [hh, mm] = start.split(':').map(Number);
  const startMin = hh * 60 + mm;
  let startSlot = Math.floor((startMin - START_MIN) / SLOT_MIN);
  startSlot = clamp(startSlot, 0, ROWS - 1);
  const slots = durationToSlots(duration);

  if (!canPlace(day, startSlot, slots)) {
    alert('此時段與既有行程衝突或超出範圍');
    return;
  }
  occupyRange(day, startSlot, slots, true);
  addEventBlock({ day, startSlot, slots, title, type: 'course' });
  courseForm.reset();
  document.getElementById('course-duration').value = 90;
  document.getElementById('course-start').value = '10:00';
});

// Allow dropping scheduled task back to TODO list
todoList.addEventListener('dragover', (e) => {
  if (!draggingTask || !draggingTask.fromEvent) return;
  e.preventDefault();
  todoList.classList.add('drop-target');
});
todoList.addEventListener('dragleave', (e) => {
  if (e.relatedTarget && todoList.contains(e.relatedTarget)) return;
  todoList.classList.remove('drop-target');
});
todoList.addEventListener('drop', (e) => {
  if (!draggingTask || !draggingTask.fromEvent || !draggingTask.eventEl) return;
  e.preventDefault();
  todoList.classList.remove('drop-target');
  const el = draggingTask.eventEl;
  const day = parseInt(el.dataset.day, 10);
  const start = parseInt(el.dataset.start, 10);
  occupyRange(day, start, draggingTask.slots, false);
  addTodoItem(draggingTask.title, draggingTask.slots * SLOT_MIN);
  const id = parseInt(el.dataset.id || '0', 10);
  if (id) removeEventById(id);
  saveState();
  el.remove();
  draggingTask = null;
});

// Inject backup panel UI without editing HTML
function injectBackupPanel() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <h2>資料備份</h2>
    <div class="row">
      <button id="btn-export" type="button">匯出 JSON</button>
      <button id="btn-import" type="button">匯入 JSON</button>
    </div>
    <input id="import-file" type="file" accept="application/json" style="display:none" />
  `;
  sidebar.appendChild(panel);
  const btnExport = panel.querySelector('#btn-export');
  const btnImport = panel.querySelector('#btn-import');
  const fileInput = panel.querySelector('#import-file');
  btnExport.addEventListener('click', () => {
    const state = { version: 1, nextId, events, todos };
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'schedule-backup.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  btnImport.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const text = await file.text();
    try {
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.events) || !Array.isArray(data.todos)) throw new Error('bad');
      events = data.events;
      todos = data.todos;
      nextId = data.nextId || (Math.max(0, ...events.map(ev=>ev.id||0)) + 1);
      saveState();
      await loadState();
    } catch (err) {
      alert('匯入失敗：JSON 格式不正確');
    } finally {
      fileInput.value = '';
    }
  });
}

// Resize (adjust duration) for task events via handle
let resizing = null; // {el, id, day, start, originalSlots}
document.addEventListener('mousedown', (e) => {
  const handle = e.target.closest('.resize-handle');
  if (!handle) return;
  const el = handle.closest('.event.task');
  if (!el) return;
  const id = parseInt(el.dataset.id || '0', 10);
  const day = parseInt(el.dataset.day, 10);
  const start = parseInt(el.dataset.start, 10);
  const originalSlots = parseInt(el.dataset.slots, 10);
  resizing = { el, id, day, start, originalSlots };
  e.preventDefault();
});
document.addEventListener('mousemove', (e) => {
  if (!resizing) return;
  const rowHeight = parseFloat(getComputedStyle(grid).gridAutoRows);
  const rect = resizing.el.getBoundingClientRect();
  const deltaY = e.clientY - rect.top; // from top of element
  let newSlots = Math.max(1, Math.round(deltaY / rowHeight));
  const ignoreRange = { day: resizing.day, start: resizing.start, end: resizing.start + resizing.originalSlots };
  if (!canPlace(resizing.day, resizing.start, newSlots, ignoreRange)) return;
  resizing.el.dataset.slots = String(newSlots);
  positionEventEl(resizing.el);
  updateEventTimeLabel(resizing.el);
});
document.addEventListener('mouseup', () => {
  if (!resizing) return;
  const newSlots = parseInt(resizing.el.dataset.slots, 10);
  occupyRange(resizing.day, resizing.start, resizing.originalSlots, false);
  occupyRange(resizing.day, resizing.start, newSlots, true);
  const ev = findEventById(resizing.id);
  if (ev) { ev.slots = newSlots; saveState(); }
  resizing = null;
});

async function init() {
  // apply default slot height before grid builds
  applySlotHeight(slotH);
  createGrid();
  setupGridDnD();
  requestPersistentStorage();
  const loaded = await loadState();
  if (!loaded) {
    addTodoItem('寫報告：研究方法', 90);
    addTodoItem('回覆 Email', 30);
    addTodoItem('程式作業 Lab1', 120);
  }
  injectBackupPanel();
  // hook up vertical zoom slider
  const rng = document.getElementById('slotHRange');
  if (rng) {
    rng.value = String(slotH);
    rng.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      applySlotHeight(v);
      saveState();
    });
  }
}

window.addEventListener('load', init);
window.addEventListener('resize', () => {
  document.querySelectorAll('.event').forEach(el => positionEventEl(el));
});
