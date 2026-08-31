import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { AutoArchiveSweepResult, triageSidebarRpcContract } from "./server";
import { summarize, untilLabel } from "./auto-archive-report";

/**
 * A "Run now" button for the auto-archive sweep, and a report of what that
 * run did.
 *
 * The sweep is invisible by design — it runs on its own interval and
 * archives threads you had already stopped caring about — which also means
 * there is no way to tell a sweep that found nothing from one that is broken.
 * This button is how you ask. It runs the same code the schedule runs, under the same
 * switch and the same retention period, so what you see here is what the
 * schedule does.
 *
 * The report names the threads rather than counting them. An archive is the
 * one action here the user cannot undo from the sidebar — the thread is gone
 * from the list once it happens — so the names are what makes it checkable.
 */
export function AutoArchiveSettings() {
  const rpc = useRpc<typeof triageSidebarRpcContract>();
  const [isRunning, setRunning] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [status, setStatus] = useState<SweepStatus | null>(null);

  // Re-read rather than compute the countdown locally: the interval setting
  // can change in the panel right above this one, and the schedule's clock is
  // the server's.
  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await rpc.call("autoArchiveStatus", {}));
    } catch {
      // The next sweep's time is a courtesy, not the point of this panel. A
      // failed read leaves the line out instead of taking the section down.
      setStatus(null);
    }
  }, [rpc]);

  // Read when the panel opens and again after a run, and not on a timer. The
  // countdown is a courtesy on a page nothing else polls, and a settings page
  // left open for an hour does not deserve sixty round trips to keep one
  // sentence current. The cost is that the line ages while you read it, which
  // is why it carries a clock time as well: that one does not go stale.
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const run = async () => {
    setRunning(true);
    // The previous run's report is cleared first: leaving it on screen while
    // the next one works would show a stale answer under a live spinner.
    setReport(null);
    try {
      setReport({ kind: "ran", result: await rpc.call("runAutoArchive", {}) });
    } catch (error) {
      setReport({ kind: "failed", message: String(error) });
    } finally {
      setRunning(false);
      // The run moved the clock it just reported on.
      void refreshStatus();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={isRunning}
          onClick={() => void run()}
          className="shrink-0 cursor-pointer rounded-md border border-input px-2 py-1 text-2xs text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isRunning ? "Running…" : "Run now"}
        </button>
        <span className="text-2xs text-muted-foreground">
          Runs the same sweep as the schedule, with the settings above, and
          does not wait for the interval.
        </span>
      </div>
      {status === null ? null : <NextRunLine status={status} />}
      {report === null ? null : <ReportBlock report={report} />}
    </div>
  );
}

interface SweepStatus {
  enabled: boolean;
  intervalHours: number;
  days: number;
  lastRunAt: number | null;
  nextRunAt: number;
  now: number;
}

/**
 * When the sweep runs next, and on what rhythm.
 *
 * The clock time and the countdown are both shown because they answer
 * different questions: "18:00" is what you check against your own day, and
 * "in 3h" is what tells you whether waiting is reasonable.
 */
function NextRunLine({ status }: { status: SweepStatus }) {
  if (!status.enabled) {
    return (
      <p className="text-2xs text-muted-foreground">
        Auto-archive is off, so no sweep is scheduled.
      </p>
    );
  }
  const clock = new Date(status.nextRunAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <p className="text-2xs text-muted-foreground">
      Next sweep at {clock} ({untilLabel(status.nextRunAt, status.now)}), then
      every {status.intervalHours}h. Threads are archived after{" "}
      {status.days} days on the shelf.
    </p>
  );
}

type Report =
  | { kind: "ran"; result: AutoArchiveSweepResult }
  | { kind: "failed"; message: string };

function ReportBlock({ report }: { report: Report }) {
  if (report.kind === "failed") {
    return (
      // `alert`, not `status`: this answers a button the user just pressed,
      // and a sweep that could not run is worth interrupting for.
      <p role="alert" className="text-2xs text-muted-foreground">
        The sweep could not run. {report.message}
      </p>
    );
  }

  const { enabled, days, candidates, archived, skipped, unsettled, failed } =
    report.result;

  // The switch being off is not a result, it is the reason there is none.
  // Reporting zeros here would read as "nothing was old enough".
  if (!enabled) {
    return (
      <p role="alert" className="text-2xs text-muted-foreground">
        Auto-archive is turned off, so nothing was swept. Turn it on above to
        use this.
      </p>
    );
  }

  return (
    <div role="alert" className="flex flex-col gap-1">
      <p className="text-2xs text-muted-foreground">
        {summarize({ days, candidates, archived, skipped, unsettled, failed })}
      </p>
      {archived.length === 0 ? null : (
        <ul className="flex flex-col gap-0.5">
          {archived.map((thread) => (
            <li
              key={thread.threadId}
              className="truncate text-2xs text-foreground"
            >
              {thread.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
