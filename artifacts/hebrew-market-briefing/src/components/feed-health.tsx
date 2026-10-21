import {
  getGetNewsSourcesHealthQueryKey,
  useGetNewsSourcesHealth,
} from "@workspace/api-client-react";
import { Activity, AlertCircle, CheckCircle2, Clock3 } from "lucide-react";

const categoryLabels = {
  world: "חדשות עולם",
  trump: "טראמפ",
  markets: "שווקים וטכנולוגיה",
} as const;

function formatDate(value: string | null): string {
  if (!value) return "טרם נבדק";
  return new Intl.DateTimeFormat("he-IL", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatError(value: string | null): string {
  if (!value) return "";
  const status = value.match(/^HTTP (\d+)$/);
  return status ? `המקור השיב בקוד ${status[1]}` : "לא ניתן היה לקרוא את העדכון האחרון";
}

export function FeedHealth() {
  const { data, isLoading, isError } = useGetNewsSourcesHealth({
    query: {
      queryKey: getGetNewsSourcesHealthQueryKey(),
      refetchInterval: 60_000,
    },
  });

  return (
    <section
      aria-labelledby="source-health-heading"
      className="mt-8 rounded-2xl border border-border bg-background/70 p-5"
      data-testid="section-source-health"
      dir="rtl"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 id="source-health-heading" className="font-bold">
            מצב מקורות החדשות
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            עדכון אוטומטי בכל דקה
          </p>
        </div>
        <Activity className="shrink-0 text-primary" size={19} aria-hidden="true" />
      </div>

      {isLoading && (
        <p className="text-sm text-muted-foreground" data-testid="status-source-health-loading">
          טוען את מצב המקורות…
        </p>
      )}
      {isError && (
        <p className="text-sm text-muted-foreground" data-testid="status-source-health-error">
          לא ניתן לטעון כרגע את מצב המקורות.
        </p>
      )}
      {data && (
        <ul className="divide-y divide-border" data-testid="list-source-health">
          {data.map((source) => {
            const attemptIsStale =
              source.lastAttemptAt != null &&
              Date.now() - new Date(source.lastAttemptAt).getTime() > 30 * 60_000;
            const failed = Boolean(source.lastError);
            const neverChecked = source.lastAttemptAt == null;
            const status = failed
              ? "שגיאה בעדכון"
              : attemptIsStale
                ? "העדכון מתעכב"
                : neverChecked
                  ? "טרם נבדק"
                  : "פעיל";
            const statusClass = failed
              ? "text-destructive"
              : attemptIsStale
                ? "text-amber-700 dark:text-amber-400"
                : neverChecked
                  ? "text-muted-foreground"
                  : "text-primary";
            const StatusIcon = failed
              ? AlertCircle
              : attemptIsStale || neverChecked
                ? Clock3
                : CheckCircle2;

            return (
              <li
                key={source.id}
                className="py-3 first:pt-0 last:pb-0"
                data-testid={`row-source-health-${source.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{source.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {categoryLabels[source.category]}
                    </p>
                  </div>
                  <span className={`flex shrink-0 items-center gap-1 text-xs font-semibold ${statusClass}`}>
                    <StatusIcon size={14} aria-hidden="true" />
                    {status}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    בדיקה אחרונה: {formatDate(source.lastAttemptAt)}
                  </span>
                  <span>{source.recentStoryCount} כתבות עדכניות</span>
                </div>
                {failed && (
                  <p className="mt-1 text-xs text-destructive">
                    {formatError(source.lastError)}
                    {source.lastSuccessfulFetch && (
                      <> · הצלחה אחרונה: {formatDate(source.lastSuccessfulFetch)}</>
                    )}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
