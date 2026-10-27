import { useChatStore } from '../store/chatStore';
import Dialog from './ui/Dialog';

// The store's dialog config maps straight onto the ui/Dialog primitive —
// handlers stay in the store, the shell is the design system.
export default function GlobalDialog() {
  const dialog = useChatStore((state) => state.dialog);
  const closeDialog = useChatStore((state) => state.closeDialog);

  return (
    <Dialog
      open={Boolean(dialog)}
      onClose={closeDialog}
      title={dialog?.title}
      message={dialog?.message}
      danger={dialog?.type === 'danger'}
      confirmText={dialog?.confirmText}
      onConfirm={(value) => dialog?.onConfirm?.(dialog.hasInput ? value : undefined)}
      hasInput={Boolean(dialog?.hasInput)}
      inputDefault={dialog?.inputDefault || ''}
      inputLocked={Boolean(dialog?.inputLocked)}
      inputRows={dialog?.inputRows || 4}
      inputPlaceholder={dialog?.placeholder || ''}
    />
  );
}
