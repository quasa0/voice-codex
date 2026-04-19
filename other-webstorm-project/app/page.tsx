"use client";

import { FormEvent, useMemo, useState } from "react";

type Todo = {
  id: number;
  text: string;
  done: boolean;
};

const initialTodos: Todo[] = [
  { id: 1, text: "Set up the Next.js app", done: true },
  { id: 2, text: "Add a new task", done: false },
  { id: 3, text: "Finish the todo list", done: false },
];

export default function Home() {
  const [todos, setTodos] = useState<Todo[]>(initialTodos);
  const [draft, setDraft] = useState("");

  const remaining = useMemo(
    () => todos.filter((todo) => !todo.done).length,
    [todos]
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const text = draft.trim();
    if (!text) {
      return;
    }

    setTodos((current) => [
      {
        id: Date.now(),
        text,
        done: false,
      },
      ...current,
    ]);
    setDraft("");
  }

  function toggleTodo(id: number) {
    setTodos((current) =>
      current.map((todo) =>
        todo.id === id ? { ...todo, done: !todo.done } : todo
      )
    );
  }

  function deleteTodo(id: number) {
    setTodos((current) => current.filter((todo) => todo.id !== id));
  }

  function clearCompleted() {
    setTodos((current) => current.filter((todo) => !todo.done));
  }

  return (
    <main className="page-shell">
      <section className="hero">
        <p className="eyebrow">Next.js Todo App</p>
        <h1>Keep the list tight and actually finish things.</h1>
        <p className="intro">
          A small todo app with add, complete, delete, and clear-completed
          actions.
        </p>
      </section>

      <section className="card">
        <form className="composer" onSubmit={handleSubmit}>
          <input
            aria-label="New todo"
            className="todo-input"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="What needs to get done?"
            value={draft}
          />
          <button className="primary-button" type="submit">
            Add Task
          </button>
        </form>

        <div className="toolbar">
          <p>
            <strong>{remaining}</strong> task{remaining === 1 ? "" : "s"} left
          </p>
          <button className="ghost-button" onClick={clearCompleted} type="button">
            Clear Completed
          </button>
        </div>

        <ul className="todo-list">
          {todos.map((todo) => (
            <li className="todo-item" key={todo.id}>
              <label className="todo-main">
                <input
                  checked={todo.done}
                  onChange={() => toggleTodo(todo.id)}
                  type="checkbox"
                />
                <span className={todo.done ? "done" : ""}>{todo.text}</span>
              </label>
              <button
                aria-label={`Delete ${todo.text}`}
                className="delete-button"
                onClick={() => deleteTodo(todo.id)}
                type="button"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
