const TASKS_KEY = "iterative-todo-tasks";
const priorityOrder = { high: 3, medium: 2, low: 1 };

const elements = {
  list: document.getElementById("todo-list"),
  total: document.getElementById("total-count"),
  done: document.getElementById("done-count"),
  pending: document.getElementById("pending-count"),
  filters: document.querySelectorAll(".filters button"),
  form: document.getElementById("todo-form"),
  input: document.getElementById("todo-input"),
  priority: document.getElementById("priority-select"),
};

let tasks = JSON.parse(localStorage.getItem(TASKS_KEY) || "[]");
let filterMode = "all";

const saveTasks = () => {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
};

const summarize = () => {
  const doneCount = tasks.filter((task) => task.done).length;
  const pendingCount = tasks.length - doneCount;
  elements.total.textContent = tasks.length;
  elements.done.textContent = doneCount;
  elements.pending.textContent = pendingCount;
};

const createTaskItem = (task) => {
  const li = document.createElement("li");
  li.className = "todo-item";
  li.dataset.state = task.done ? "done" : "pending";

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = task.done;
  toggle.id = `check-${task.id}`;
  toggle.addEventListener("change", () => toggleTask(task.id));

  const label = document.createElement("label");
  label.htmlFor = toggle.id;
  label.innerHTML = `
    <div>
      <strong>${task.title}</strong>
      <p>${new Date(task.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</p>
    </div>
  `;

  const priority = document.createElement("span");
  priority.className = `priority-chip ${task.priority}`;
  priority.textContent = task.priority;

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.textContent = "✕";
  deleteButton.addEventListener("click", () => deleteTask(task.id));

  label.prepend(toggle);
  li.append(label, priority, deleteButton);
  return li;
};

const render = () => {
  elements.list.innerHTML = "";
  const filtered = tasks.filter((task) => {
    if (filterMode === "all") return true;
    return filterMode === "done" ? task.done : !task.done;
  });

  filtered
    .sort((a, b) => {
      if (priorityOrder[b.priority] !== priorityOrder[a.priority]) {
        return priorityOrder[b.priority] - priorityOrder[a.priority];
      }
      return new Date(b.createdAt) - new Date(a.createdAt);
    })
    .forEach((task) => elements.list.append(createTaskItem(task)));

  summarize();
};

const toggleTask = (id) => {
  tasks = tasks.map((task) => (task.id === id ? { ...task, done: !task.done } : task));
  saveTasks();
  render();
};

const deleteTask = (id) => {
  tasks = tasks.filter((task) => task.id !== id);
  saveTasks();
  render();
};

const addTask = (title, priority) => {
  const newTask = {
    id: crypto.randomUUID(),
    title,
    priority,
    done: false,
    createdAt: new Date().toISOString(),
  };
  tasks = [...tasks, newTask];
  saveTasks();
  render();
};

const setFilter = (mode) => {
  filterMode = mode;
  elements.filters.forEach((btn) => btn.classList.toggle("active", btn.dataset.filter === mode));
  render();
};

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = elements.input.value.trim();
  if (!text) return;
  addTask(text, elements.priority.value);
  elements.input.value = "";
  elements.input.focus();
});

elements.filters.forEach((button) => {
  button.addEventListener("click", () => setFilter(button.dataset.filter));
});

if (tasks.length === 0) setFilter("all");
render();
