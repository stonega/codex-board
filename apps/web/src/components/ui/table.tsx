import type {
  HTMLAttributes,
  PropsWithChildren,
  TableHTMLAttributes,
} from 'react';

import { cn } from '../../lib/utils';

export function Table({
  className,
  ...props
}: TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn('ui-table', className)} {...props} />;
}

export function TableWrapper({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('ui-table-wrapper', className)} {...props} />;
}

export function TableEmpty({ children }: PropsWithChildren) {
  return <div className="ui-table-empty">{children}</div>;
}
