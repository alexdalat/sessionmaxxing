"use client";
import { Runs } from "@/app/components/runs/Runs";

export default function RunsPage() {
  return (
    <>
      <h1 className="sr-only">Runs</h1>
      <div className="bento">
        <Runs />
      </div>
    </>
  );
}
