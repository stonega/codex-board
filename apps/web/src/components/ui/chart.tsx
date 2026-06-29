import * as React from 'react';
import { Tooltip as RechartsTooltip, ResponsiveContainer } from 'recharts';

import { cn } from '../../lib/utils';

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    color?: string;
  }
>;

type ChartContextValue = {
  config: ChartConfig;
};

type TooltipPayloadItem = {
  color?: string;
  dataKey?: string | number;
  name?: string | number;
  value?: string | number;
};

const ChartContext = React.createContext<ChartContextValue | null>(null);

function useChart() {
  const context = React.useContext(ChartContext);
  if (!context) {
    throw new Error('useChart must be used within a ChartContainer');
  }
  return context;
}

export function ChartContainer({
  id,
  className,
  children,
  config,
}: {
  id?: string;
  className?: string;
  children: React.ReactElement;
  config: ChartConfig;
}) {
  const uniqueId = React.useId();
  const chartId = `chart-${id ?? uniqueId.replace(/:/g, '')}`;
  const style = Object.fromEntries(
    Object.entries(config).flatMap(([key, item]) =>
      item.color ? [[`--color-${key}`, item.color]] : [],
    ),
  ) as React.CSSProperties;

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        className={cn(
          'flex h-[260px] w-full justify-center text-[0.75rem]',
          '[&_.recharts-cartesian-axis-tick_text]:fill-notion-muted',
          '[&_.recharts-cartesian-grid_line]:stroke-notion-border',
          '[&_.recharts-curve.recharts-tooltip-cursor]:stroke-notion-border',
          '[&_.recharts-dot[stroke="#fff"]]:stroke-transparent',
          '[&_.recharts-sector]:outline-none',
          className,
        )}
        data-chart={chartId}
        style={style}
      >
        <ResponsiveContainer>{children}</ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = RechartsTooltip;

export function ChartTooltipContent({
  active,
  payload,
  label,
  className,
  indicator = 'dot',
  hideLabel = false,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string;
  className?: string;
  indicator?: 'dot' | 'line' | 'dashed';
  hideLabel?: boolean;
}) {
  const { config } = useChart();

  if (!active || !payload?.length) {
    return null;
  }

  return (
    <div
      className={cn(
        'grid min-w-[160px] gap-1.5 rounded-lg border border-notion-border bg-white px-3 py-2 text-[0.75rem] shadow-md',
        className,
      )}
    >
      {!hideLabel && label ? (
        <div className="font-medium text-notion-text">{label}</div>
      ) : null}
      <div className="grid gap-1.5">
        {payload.map((item) => {
          const key = String(item.dataKey ?? item.name ?? '');
          const itemConfig = config[key];
          const color = item.color ?? itemConfig?.color ?? 'var(--notion-blue)';
          const value =
            typeof item.value === 'number'
              ? item.value.toLocaleString(undefined, {
                  maximumFractionDigits: 6,
                })
              : item.value;

          return (
            <div className="flex items-center gap-2" key={key}>
              <span
                className={cn(
                  'shrink-0 border',
                  indicator === 'dot' ? 'size-2 rounded-full' : 'h-0 w-3',
                  indicator === 'dashed' ? 'border-dashed' : null,
                )}
                style={{
                  backgroundColor: indicator === 'dot' ? color : 'transparent',
                  borderColor: color,
                }}
              />
              <span className="min-w-0 flex-1 text-notion-muted">
                {itemConfig?.label ?? item.name ?? key}
              </span>
              <span className="font-mono font-medium text-notion-text">
                {value}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
