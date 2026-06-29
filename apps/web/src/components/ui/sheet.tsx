import { AnimatePresence, motion } from 'framer-motion';
import type { PropsWithChildren } from 'react';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';

interface SheetProps extends PropsWithChildren {
  open: boolean;
  onClose: () => void;
  title: string;
  variant?: 'side' | 'modal';
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  variant = 'side',
}: SheetProps) {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <div
          className={`fixed inset-0 z-[100] overflow-hidden ${variant === 'modal' ? 'flex items-center justify-center p-6' : 'flex justify-end'}`}
          role="presentation"
        >
          <motion.div
            aria-hidden="true"
            className="absolute inset-0 bg-black/15"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
          />
          <motion.aside
            aria-label={title}
            className={
              variant === 'modal'
                ? 'relative z-10 w-full max-w-2xl rounded-2xl border border-notion-border bg-white shadow-2xl overflow-y-auto max-h-[calc(100vh-3rem)]'
                : 'relative h-full w-full max-w-[720px] bg-white shadow-2xl overflow-y-auto'
            }
            initial={
              variant === 'modal'
                ? { opacity: 0, y: 24, scale: 0.98 }
                : { x: '100%' }
            }
            animate={
              variant === 'modal' ? { opacity: 1, y: 0, scale: 1 } : { x: 0 }
            }
            exit={
              variant === 'modal'
                ? { opacity: 0, y: 24, scale: 0.98 }
                : { x: '100%' }
            }
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }} // smooth ease-out-expo
          >
            <div className={variant === 'modal' ? 'p-6 sm:p-8' : 'p-12'}>
              {children}
            </div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
