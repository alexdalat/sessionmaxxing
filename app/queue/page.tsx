"use client";
import { TaskQueue } from "@/app/components/queue/TaskQueue";

export default function QueuePage() {
  return (
    <>
      <h1 className="sr-only">Task queue</h1>
      <div className="bento">
        <TaskQueue />
      </div>
    </>
  );
}
