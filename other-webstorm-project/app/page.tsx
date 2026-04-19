"use client";

import { FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Plus, Trash2 } from "lucide-react";

type Todo = {
  id: string;
  text: string;
  done: boolean;
};

const STORAGE_KEY = "quasa-inspired-todos";

const starterTodos: Todo[] = [
  { id: "1", text: "Write down the next task", done: false },
  { id: "2", text: "Finish one thing", done: true },
  { id: "3", text: "Keep the list short", done: false },
];

export default function Home() {
  const [draft, setDraft] = useState("");
  const [todos, setTodos] = useState<Todo[]>(starterTodos);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);

    if (saved) {
      try {
        const parsed = JSON.parse(saved) as Todo[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          setTodos(parsed);
        }
      } catch {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    }

    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
  }, [hydrated, todos]);

  const remaining = todos.filter((todo) => !todo.done).length;
  const completed = todos.length - remaining;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const text = draft.trim();
    if (!text) {
      return;
    }

    setTodos((current) => [
      { id: crypto.randomUUID(), text, done: false },
      ...current,
    ]);
    setDraft("");
  }

  function toggleTodo(id: string, done: boolean) {
    setTodos((current) =>
      current.map((todo) => (todo.id === id ? { ...todo, done } : todo)),
    );
  }

  function deleteTodo(id: string) {
    setTodos((current) => current.filter((todo) => todo.id !== id));
  }

  function clearCompleted() {
    setTodos((current) => current.filter((todo) => !todo.done));
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-4 py-10">
      <section className="w-full rounded-[1.75rem] border border-white/10 bg-white/[0.035] p-4 shadow-[0_24px_80px_rgba(0,0,0,0.38)] backdrop-blur-xl sm:p-5">
        <form
          className="flex gap-2 border-b border-white/8 pb-4"
          onSubmit={handleSubmit}
        >
          <Input
            aria-label="New todo"
            className="h-11 rounded-xl border-white/8 bg-transparent px-4 text-sm text-white shadow-none placeholder:text-muted-foreground focus-visible:border-white/12 focus-visible:ring-0"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Add task"
            value={draft}
          />
          <Button
            className="h-11 rounded-xl bg-white text-black hover:bg-white/90"
            type="submit"
          >
            <Plus className="size-4" />
          </Button>
        </form>

        <div className="flex items-center justify-between px-1 py-4 text-sm">
          <span className="text-muted-foreground">
            {remaining} left
          </span>
          <Button
            className="h-auto rounded-lg px-2 py-1 text-muted-foreground hover:bg-white/6 hover:text-white"
            disabled={completed === 0}
            onClick={clearCompleted}
            type="button"
            variant="ghost"
          >
            Clear completed
          </Button>
        </div>

        <ul className="space-y-2">
          {todos.map((todo) => (
            <li key={todo.id}>
              <div
                className={cn(
                  "group flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.025] px-3 py-3",
                  todo.done && "opacity-60",
                )}
              >
                <Checkbox
                  checked={todo.done}
                  className="size-5 rounded-md border-white/20 data-[checked=true]:border-primary data-[checked=true]:bg-primary data-[checked=true]:text-primary-foreground"
                  onCheckedChange={(checked) =>
                    toggleTodo(todo.id, checked === true)
                  }
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 text-sm text-white",
                    todo.done && "text-muted-foreground line-through",
                  )}
                >
                  {todo.text}
                </span>
                <Button
                  aria-label={`Delete ${todo.text}`}
                  className="rounded-lg opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={() => deleteTodo(todo.id)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
