"use client";
import { XIcon } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { ACTION_LABELS } from "@/app/lib/labels";

export function ConfirmDialog({
  open,
  title,
  detail,
  confirmLabel,
  dismissLabel,
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  detail: string;
  confirmLabel: string;
  dismissLabel: string;
  danger?: boolean;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[400px]" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="wrap-anywhere">
            {detail}
          </DialogDescription>
        </DialogHeader>
        <div className="actions">
          <Button type="button" variant="outline" onClick={onClose}>
            {dismissLabel}
          </Button>
          <Button
            type="button"
            variant={danger ? "destructive" : "default"}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
        <DialogClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="dialog-close"
            aria-label={ACTION_LABELS.closeDialog}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
