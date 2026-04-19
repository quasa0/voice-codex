const calendarGrid = document.getElementById("calendar-grid");
const monthLabel = document.getElementById("month-label");
const selectedDateEl = document.getElementById("selected-date");
const eventsList = document.getElementById("events-list");
const eventCount = document.getElementById("event-count");
const prevBtn = document.getElementById("prev-month");
const nextBtn = document.getElementById("next-month");
const eventForm = document.getElementById("event-form");
const titleInput = document.getElementById("event-title");
const timeInput = document.getElementById("event-time");
const colorInput = document.getElementById("event-color");
const notesInput = document.getElementById("event-notes");

const STORAGE_KEY = "pulse_calendar_events";
let events = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
let current = new Date();
let selectedDate = new Date();

const formatMonthLabel = (date) => date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
const formatDateLabel = (date) => date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
const isoDate = (date) => date.toISOString().split("T")[0];

const persist = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(events));

const getEventsFor = (date) => events[isoDate(date)] || [];

const updateSelectedLabel = () => {
  selectedDateEl.textContent = formatDateLabel(selectedDate);
};

const setSelectedDate = (date) => {
  selectedDate = clampDate(date);
  updateSelectedLabel();
  renderCalendar();
  renderEvents();
};

const renderEvents = () => {
  const eventArray = getEventsFor(selectedDate).sort((a, b) => (a.time || "") .localeCompare(b.time || ""));
  eventsList.innerHTML = "";

  if (!eventArray.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Pick a date to see or add events.";
    eventsList.appendChild(empty);
  } else {
    eventArray.forEach((event) => {
      const card = document.createElement("article");
      card.className = "event-card";
      const badge = document.createElement("span");
      badge.className = "event-color-dot";
      badge.style.background = event.color;

      const titleRow = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = event.title;
      titleRow.append(badge, title);

      const timeTag = document.createElement("time");
      timeTag.textContent = event.time ? event.time : "All-day";

      card.append(titleRow, timeTag);
      if (event.notes) {
        const note = document.createElement("p");
        note.textContent = event.notes;
        card.append(note);
      }

      eventsList.appendChild(card);
    });
  }

  eventCount.textContent = `${eventArray.length} event${eventArray.length === 1 ? "" : "s"}`;
};

const clampDate = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

const renderCalendar = () => {
  const year = current.getFullYear();
  const month = current.getMonth();
  const firstDay = new Date(year, month, 1);
  const startDay = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  calendarGrid.innerHTML = "";
  monthLabel.textContent = formatMonthLabel(current);

  const totalCells = 42;
  for (let i = 0; i < totalCells; i += 1) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "day-cell";

    const dayNumber = document.createElement("span");
    dayNumber.className = "day-number";

    const cellDate = new Date(year, month, 1 + (i - startDay));
    dayNumber.textContent = cellDate.getDate();
    cell.appendChild(dayNumber);

    if (cellDate.getMonth() !== month) {
      cell.classList.add("inactive");
    } else {
      const eventsForCell = getEventsFor(cellDate);
      if (eventsForCell.length) cell.classList.add("has-events");
      if (isoDate(cellDate) === isoDate(selectedDate)) {
        cell.classList.add("active");
      }
      cell.addEventListener("click", () => {
        setSelectedDate(cellDate);
      });
    }

    calendarGrid.appendChild(cell);
  }
};

const navigate = (direction) => {
  current.setMonth(current.getMonth() + direction);
  renderCalendar();
};

prevBtn.addEventListener("click", () => navigate(-1));
nextBtn.addEventListener("click", () => navigate(1));

selectedDate = clampDate(selectedDate);

eventForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const dateKey = isoDate(selectedDate);
  const payload = {
    title: titleInput.value.trim(),
    time: timeInput.value,
    color: colorInput.value,
    notes: notesInput.value.trim(),
  };

  if (!payload.title) return;

  events = {
    ...events,
    [dateKey]: [...getEventsFor(selectedDate), payload],
  };

  persist();
  eventForm.reset();
  colorInput.value = "#ff8edb";
  renderCalendar();
  renderEvents();
});

const init = () => {
  updateSelectedLabel();
  renderCalendar();
  renderEvents();
};

init();
