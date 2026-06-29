import { CalendarDays, CircleDollarSign, RefreshCw, Sigma } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from 'recharts';

import type {
  UsageDailyPoint,
  UsageRangePreset,
  UsageRefreshResponse,
  UsageSummaryResponse,
} from '@codex-boards/domain';

import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from './components/ui/card';
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from './components/ui/chart';
import { Input } from './components/ui/input';
import { Select } from './components/ui/select';
import { Table, TableEmpty, TableWrapper } from './components/ui/table';
import { resolveApiBaseUrl } from './lib/runtime';

const tokenAndCostConfig = {
  totalTokens: {
    label: 'Total tokens',
    color: 'var(--chart-1)',
  },
  estimatedCostUsd: {
    label: 'Estimated fee',
    color: 'var(--chart-2)',
  },
} satisfies ChartConfig;

const cachedInputConfig = {
  cachedInputTokens: {
    label: 'Cached input',
    color: 'var(--chart-2)',
  },
} satisfies ChartConfig;

const uncachedInputConfig = {
  uncachedInputTokens: {
    label: 'Uncached input',
    color: 'var(--chart-3)',
  },
} satisfies ChartConfig;

const reasoningConfig = {
  reasoningOutputTokens: {
    label: 'Reasoning output',
    color: 'var(--chart-4)',
  },
} satisfies ChartConfig;

const threadsConfig = {
  newThreadCount: {
    label: 'New threads',
    color: 'var(--chart-1)',
  },
} satisfies ChartConfig;

async function fetchUsage(path: string): Promise<UsageSummaryResponse> {
  const apiBaseUrl = await resolveApiBaseUrl();
  const response = await fetch(`${apiBaseUrl}${path}`);
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return (await response.json()) as UsageSummaryResponse;
}

async function refreshUsage(path: string): Promise<UsageRefreshResponse> {
  const apiBaseUrl = await resolveApiBaseUrl();
  const response = await fetch(`${apiBaseUrl}${path}`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return (await response.json()) as UsageRefreshResponse;
}

function buildUsagePath(
  basePath: string,
  preset: UsageRangePreset,
  customStartDate: string,
  customEndDate: string,
): string {
  const search = new URLSearchParams({ range: preset });
  if (preset === 'custom') {
    search.set('start', customStartDate);
    search.set('end', customEndDate);
  }

  return `${basePath}?${search.toString()}`;
}

function formatDateLabel(value: string): string {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function formatMoney(value: number | null): string {
  if (value === null) {
    return 'Unpriced';
  }

  return value.toLocaleString(undefined, {
    currency: 'USD',
    maximumFractionDigits: 4,
    minimumFractionDigits: 2,
    style: 'currency',
  });
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function todayDateKey(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftDateKey(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  const nextYear = date.getFullYear();
  const nextMonth = String(date.getMonth() + 1).padStart(2, '0');
  const nextDay = String(date.getDate()).padStart(2, '0');
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

function MetricCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <Card className="p-4">
      <CardContent className="flex items-start gap-3">
        <div className="flex size-4 shrink-0 items-center justify-center rounded-md bg-notion-active text-notion-muted">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[0.75rem] font-semibold uppercase tracking-wider text-notion-muted">
            {label}
          </p>
          <strong className="mt-1 block truncate text-xl font-semibold tracking-tight">
            {value}
          </strong>
          {detail ? (
            <p className="mt-1 truncate text-[0.75rem] text-notion-muted">
              {detail}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function LineChartCard({
  title,
  description,
  config,
  data,
  children,
}: {
  title: string;
  description: string;
  config: ChartConfig;
  data: UsageDailyPoint[];
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <ChartContainer config={config} className="h-[240px]">
          <LineChart data={data} margin={{ left: 12, right: 12 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="date"
              minTickGap={24}
              tickFormatter={formatDateLabel}
              tickLine={false}
              tickMargin={8}
            />
            {children}
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

export function UsagePage() {
  const defaultEndDate = useMemo(() => todayDateKey(), []);
  const defaultStartDate = useMemo(
    () => shiftDateKey(defaultEndDate, -6),
    [defaultEndDate],
  );
  const [rangePreset, setRangePreset] =
    useState<UsageRangePreset>('last-7-days');
  const [customStartDate, setCustomStartDate] = useState(defaultStartDate);
  const [customEndDate, setCustomEndDate] = useState(defaultEndDate);
  const [usage, setUsage] = useState<UsageSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usagePath = useMemo(
    () => buildUsagePath('/usage', rangePreset, customStartDate, customEndDate),
    [rangePreset, customStartDate, customEndDate],
  );

  useEffect(() => {
    if (rangePreset === 'custom' && (!customStartDate || !customEndDate)) {
      return;
    }

    let mounted = true;
    setLoading(true);
    setError(null);

    void fetchUsage(usagePath)
      .then((payload) => {
        if (mounted) {
          setUsage(payload);
        }
      })
      .catch((loadError) => {
        if (mounted) {
          setError(
            loadError instanceof Error ? loadError.message : 'Unknown error',
          );
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [usagePath, rangePreset, customStartDate, customEndDate]);

  async function runUsageRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      const response = await refreshUsage(
        buildUsagePath(
          '/usage/refresh',
          rangePreset,
          customStartDate,
          customEndDate,
        ),
      );
      setUsage(response.usage);
    } catch (refreshError) {
      setError(
        refreshError instanceof Error ? refreshError.message : 'Unknown error',
      );
    } finally {
      setRefreshing(false);
    }
  }

  const daily = usage?.daily ?? [];

  return (
    <div className="flex w-full flex-col gap-4 px-4 py-5 pb-12 sm:px-8 lg:px-10">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-notion-active text-notion-muted">
            <Sigma size={20} />
          </div>
          <div className="min-w-0">
            <h2 className="text-3xl font-bold leading-tight tracking-tight sm:text-[2.25rem]">
              Usage
            </h2>
            <p className="mt-1 text-sm text-notion-muted">
              {usage
                ? `${usage.range.startDate} to ${usage.range.endDate}`
                : 'Local aggregate token history'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            className="h-8"
            onChange={(event) =>
              setRangePreset(event.target.value as UsageRangePreset)
            }
            value={rangePreset}
          >
            <option value="last-7-days">Last 7 days</option>
            <option value="last-30-days">Last 30 days</option>
            <option value="custom">Custom</option>
          </Select>
          {rangePreset === 'custom' ? (
            <>
              <Input
                className="h-8 w-[150px]"
                onChange={(event) => setCustomStartDate(event.target.value)}
                type="date"
                value={customStartDate}
              />
              <Input
                className="h-8 w-[150px]"
                onChange={(event) => setCustomEndDate(event.target.value)}
                type="date"
                value={customEndDate}
              />
            </>
          ) : null}
          <Button
            disabled={refreshing}
            onClick={() => void runUsageRefresh()}
            size="sm"
            variant="outline"
          >
            <RefreshCw
              data-icon="inline-start"
              className={refreshing ? 'animate-spin size-3' : 'size-3'}
            />
            {refreshing ? 'Refreshing...' : 'Refresh usage'}
          </Button>
        </div>
      </div>

      {error ? (
        <p className="rounded border border-red-100 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <MetricCard
          detail={`${formatNumber(usage?.summary.eventCount ?? 0)} model calls`}
          icon={<Sigma />}
          label="Tokens"
          value={formatNumber(usage?.summary.totalTokens ?? 0)}
        />
        <MetricCard
          detail={
            usage?.pricing.unpricedTokens
              ? `${formatNumber(usage.pricing.unpricedTokens)} unpriced tokens`
              : 'All visible tokens priced'
          }
          icon={<CircleDollarSign />}
          label="Estimated fee"
          value={formatMoney(usage?.summary.estimatedCostUsd ?? 0)}
        />
        <MetricCard
          detail={`${formatNumber(usage?.summary.cachedInputTokens ?? 0)} cached input`}
          icon={<RefreshCw />}
          label="Cache ratio"
          value={formatPercent(usage?.summary.cacheRatio ?? 0)}
        />
        <MetricCard
          detail="New thread starts"
          icon={<CalendarDays />}
          label="Threads"
          value={formatNumber(usage?.summary.newThreadCount ?? 0)}
        />
        <MetricCard
          detail={
            usage?.refresh.refreshedAt
              ? new Date(usage.refresh.refreshedAt).toLocaleString()
              : 'Not refreshed'
          }
          icon={<RefreshCw />}
          label="Usage index"
          value={formatNumber(usage?.refresh.parsedEvents ?? 0)}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <LineChartCard
          config={tokenAndCostConfig}
          data={daily}
          description="Daily tokens with estimated USD fee"
          title="Total tokens and fee"
        >
          <>
            <YAxis
              axisLine={false}
              tickFormatter={(value) => Number(value).toLocaleString()}
              tickLine={false}
              width={56}
              yAxisId="tokens"
            />
            <YAxis
              axisLine={false}
              orientation="right"
              tickFormatter={(value) => `$${Number(value).toFixed(2)}`}
              tickLine={false}
              width={48}
              yAxisId="cost"
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Line
              dataKey="totalTokens"
              dot={false}
              stroke="var(--color-totalTokens)"
              strokeWidth={2}
              type="monotone"
              yAxisId="tokens"
            />
            <Line
              dataKey="estimatedCostUsd"
              dot={false}
              stroke="var(--color-estimatedCostUsd)"
              strokeWidth={2}
              type="monotone"
              yAxisId="cost"
            />
          </>
        </LineChartCard>

        <LineChartCard
          config={cachedInputConfig}
          data={daily}
          description="Daily cached prompt input"
          title="Cached input"
        >
          <>
            <YAxis
              axisLine={false}
              tickFormatter={(value) => Number(value).toLocaleString()}
              tickLine={false}
              width={56}
            />
            <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
            <Line
              dataKey="cachedInputTokens"
              dot={false}
              stroke="var(--color-cachedInputTokens)"
              strokeWidth={2}
              type="monotone"
            />
          </>
        </LineChartCard>

        <LineChartCard
          config={uncachedInputConfig}
          data={daily}
          description="Daily fresh prompt input"
          title="Uncached input"
        >
          <>
            <YAxis
              axisLine={false}
              tickFormatter={(value) => Number(value).toLocaleString()}
              tickLine={false}
              width={56}
            />
            <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
            <Line
              dataKey="uncachedInputTokens"
              dot={false}
              stroke="var(--color-uncachedInputTokens)"
              strokeWidth={2}
              type="monotone"
            />
          </>
        </LineChartCard>

        <LineChartCard
          config={reasoningConfig}
          data={daily}
          description="Daily reasoning output tokens"
          title="Reasoning output"
        >
          <>
            <YAxis
              axisLine={false}
              tickFormatter={(value) => Number(value).toLocaleString()}
              tickLine={false}
              width={56}
            />
            <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
            <Line
              dataKey="reasoningOutputTokens"
              dot={false}
              stroke="var(--color-reasoningOutputTokens)"
              strokeWidth={2}
              type="monotone"
            />
          </>
        </LineChartCard>

        <Card className="xl:col-span-2">
          <CardHeader className="p-4 pb-2">
            <CardTitle>Threads count</CardTitle>
            <CardDescription>Newly started threads per day</CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <ChartContainer config={threadsConfig} className="h-[240px]">
              <BarChart data={daily}>
                <CartesianGrid vertical={false} />
                <XAxis
                  axisLine={false}
                  dataKey="date"
                  minTickGap={24}
                  tickFormatter={formatDateLabel}
                  tickLine={false}
                  tickMargin={8}
                />
                <YAxis
                  allowDecimals={false}
                  axisLine={false}
                  tickLine={false}
                />
                <ChartTooltip
                  content={<ChartTooltipContent indicator="dashed" />}
                />
                <Bar
                  dataKey="newThreadCount"
                  fill="var(--color-newThreadCount)"
                  radius={4}
                />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Pricing coverage</CardTitle>
          <CardDescription>
            {usage?.pricing.loaded
              ? `${formatPercent(usage.pricing.pricedTokenRatio)} of selected tokens priced`
              : 'Local pricing file not found'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {usage?.models.length ? (
            <TableWrapper>
              <Table className="min-w-[760px]">
                <thead>
                  <tr className="border-b border-notion-border">
                    <th className="w-full py-2 px-3 text-left text-sm font-medium text-notion-muted">
                      Model
                    </th>
                    <th className="w-[1%] py-2 px-3 text-left text-sm font-medium text-notion-muted whitespace-nowrap">
                      Status
                    </th>
                    <th className="w-[1%] py-2 px-3 text-right text-sm font-medium text-notion-muted whitespace-nowrap">
                      Tokens
                    </th>
                    <th className="w-[1%] py-2 px-3 text-right text-sm font-medium text-notion-muted whitespace-nowrap">
                      Fee
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {usage.models.map((model) => (
                    <tr
                      className="border-b border-notion-border last:border-b-0"
                      key={model.model}
                    >
                      <td className="py-2 px-3 align-top">
                        <strong className="block text-sm font-medium">
                          {model.model}
                        </strong>
                        {model.pricedAs && model.pricedAs !== model.model ? (
                          <p className="mt-0.5 text-[0.75rem] text-notion-muted">
                            Priced as {model.pricedAs}
                          </p>
                        ) : null}
                      </td>
                      <td className="py-2 px-3 align-top whitespace-nowrap">
                        <Badge>{model.pricingStatus}</Badge>
                      </td>
                      <td className="py-2 px-3 align-top text-right text-sm whitespace-nowrap">
                        {formatNumber(model.totalTokens)}
                      </td>
                      <td className="py-2 px-3 align-top text-right text-sm whitespace-nowrap">
                        {formatMoney(model.estimatedCostUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrapper>
          ) : (
            <TableEmpty>No model usage in the selected interval.</TableEmpty>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
