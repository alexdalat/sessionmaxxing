"use client";
import { TaskQueue } from "../TaskQueue";

export default function QueuePage() {
  return (
    <>
      <header className="page-header">
        <h1>Task queue</h1>
      </header>
      <TaskQueue />
    </>
  );
}
