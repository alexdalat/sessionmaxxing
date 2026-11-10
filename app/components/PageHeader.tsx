import type { ReactNode } from "react";

export function PageHeader({
  title,
  status,
  actions,
}: {
  title: string;
  status?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="min-w-0">
        <h1 className="page-title">{title}</h1>
        {status && <div className="page-status">{status}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
