import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, Play, Power, Plus, Trash2 } from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { widthPercentClass } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

export type WebhookStatus = "active" | "disabled" | "failing";

export type WebhookItem = {
  id: string;
  name: string;
  url: string;
  events: string[];
  status: WebhookStatus;
  lastTriggered: string;
  successRate: number;
};

const statusStyles: Record<
  WebhookStatus,
  { labelKey: string; className: string }
> = {
  active: {
    labelKey: "common:states.active",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  disabled: {
    labelKey: "common:states.disabled",
    className: "border-slate-200 bg-slate-50 text-slate-600",
  },
  failing: {
    labelKey: "webhookList.failing",
    className: "border-rose-200 bg-rose-50 text-rose-700",
  },
};

type WebhookListProps = {
  onAdd?: () => void;
  onEdit?: (webhook: WebhookItem) => void;
};

export default function WebhookList({ onAdd, onEdit }: WebhookListProps) {
  const { t } = useTranslation("integrations");
  const [webhooks, setWebhooks] = useState<WebhookItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchWebhooks = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth("/webhooks");
      if (!response.ok) {
        throw new Error(t("webhookList.failedToFetchWebhooks"));
      }
      const data = await response.json();
      setWebhooks(data.webhooks ?? data ?? []);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("webhookList.anErrorOccurred"),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWebhooks();
  }, [fetchWebhooks]);

  const averageSuccess = useMemo(() => {
    if (webhooks.length === 0) return 0;
    const total = webhooks.reduce(
      (acc, webhook) => acc + webhook.successRate,
      0,
    );
    return Math.round(total / webhooks.length);
  }, [webhooks]);

  const handleToggle = async (id: string) => {
    const webhook = webhooks.find((w) => w.id === id);
    if (!webhook) return;

    const nextStatus = webhook.status === "active" ? "disabled" : "active";
    const enabled = nextStatus === "active";

    try {
      const response = await fetchWithAuth(`/webhooks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });

      if (!response.ok) {
        throw new Error(t("webhookList.failedToToggleWebhook"));
      }

      setWebhooks((prev) =>
        prev.map((w) => (w.id === id ? { ...w, status: nextStatus } : w)),
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("webhookList.failedToToggleWebhook"),
      );
    }
  };

  const handleTest = async (id: string) => {
    try {
      const response = await fetchWithAuth(`/webhooks/${id}/test`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(t("webhookList.testFailed"));
      }

      setWebhooks((prev) =>
        prev.map((webhook) =>
          webhook.id === id
            ? {
                ...webhook,
                lastTriggered: t("webhookList.justNow"),
              }
            : webhook,
        ),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("webhookList.testFailed"),
      );
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const response = await fetchWithAuth(`/webhooks/${id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error(t("webhookList.failedToDeleteWebhook"));
      }

      setWebhooks((prev) => prev.filter((webhook) => webhook.id !== id));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("webhookList.failedToDeleteWebhook"),
      );
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">
            {t("webhookList.loadingWebhooks")}
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchWebhooks}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t("webhookList.tryAgain")}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t("webhookList.webhooks")}</h2>
          <p className="text-sm text-muted-foreground">
            {webhooks.length} {t("webhookList.endpoints")}
            {averageSuccess}
            {t("webhookList.averageSuccessRate")}
          </p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          {t("webhookList.addWebhook")}
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="min-w-full divide-y text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3 text-left font-semibold">
                {t("common:labels.name")}
              </th>
              <th className="px-4 py-3 text-left font-semibold">
                {t("webhookList.url")}
              </th>
              <th className="px-4 py-3 text-left font-semibold">
                {t("webhookList.events")}
              </th>
              <th className="px-4 py-3 text-left font-semibold">
                {t("common:labels.status")}
              </th>
              <th className="px-4 py-3 text-left font-semibold">
                {t("webhookList.lastTriggered")}
              </th>
              <th className="px-4 py-3 text-left font-semibold">
                {t("webhookList.successRate")}
              </th>
              <th className="px-4 py-3 text-right font-semibold">
                {t("common:labels.actions")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {webhooks.map((webhook) => {
              const status = statusStyles[webhook.status];
              return (
                <tr key={webhook.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="font-medium">{webhook.name}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="truncate text-muted-foreground">
                      {webhook.url}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-muted-foreground">
                      {webhook.events.slice(0, 2).join(", ")}
                      {webhook.events.length > 2 &&
                        ` +${webhook.events.length - 2}`}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs ${status.className}`}
                    >
                      {t(status.labelKey)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {webhook.lastTriggered}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-20 overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-full rounded-full bg-emerald-500 ${widthPercentClass(webhook.successRate)}`}
                        />
                      </div>
                      <span className="text-muted-foreground">
                        {webhook.successRate}%
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        className="rounded-md border p-2 hover:bg-muted"
                        onClick={() => onEdit?.(webhook)}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="rounded-md border p-2 hover:bg-muted"
                        onClick={() => handleTest(webhook.id)}
                      >
                        <Play className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="rounded-md border p-2 hover:bg-muted"
                        onClick={() => handleToggle(webhook.id)}
                      >
                        <Power className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="rounded-md border p-2 hover:bg-muted"
                        onClick={() => handleDelete(webhook.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
