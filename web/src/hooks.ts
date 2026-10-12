import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Status } from "@tracker/server/status";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type ApplicationInput, type Me, type ResolveAction } from "./api.ts";

const keys = {
  me: ["me"] as const,
  applications: ["applications"] as const,
  application: (id: string) => ["application", id] as const,
  review: ["review"] as const,
  flow: ["flow"] as const,
};

/** The signed-in user. Polled, faster while a sync runs, so mail synced in the background shows up. */
export const useMe = () =>
  useQuery({
    queryKey: keys.me,
    queryFn: api.me,
    retry: false,
    refetchInterval: (query) => (query.state.data?.syncing ? 2000 : 30_000),
  });

export const useApplications = (filter: { status?: Status; q?: string } = {}) =>
  useQuery({
    queryKey: [...keys.applications, filter.status ?? "all", filter.q ?? ""],
    queryFn: () => api.applications(filter),
    placeholderData: keepPreviousData,
  });

export const useApplication = (id: string) =>
  useQuery({ queryKey: keys.application(id), queryFn: () => api.application(id), retry: false });

export const useReview = () => useQuery({ queryKey: keys.review, queryFn: api.review });

export const useFlow = () => useQuery({ queryKey: keys.flow, queryFn: api.flow });

/** Refetches everything a sync or an edit can change. */
function useRefreshData() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: keys.applications }),
      client.invalidateQueries({ queryKey: ["application"] }),
      client.invalidateQueries({ queryKey: keys.review }),
      client.invalidateQueries({ queryKey: keys.flow }),
    ]);
}

/** Reloads the lists whenever a sync finishes, whoever started it. */
export function useRefreshAfterSync(me: Me) {
  const refresh = useRefreshData();
  const seen = useRef(me.lastSyncAt);
  useEffect(() => {
    if (seen.current === me.lastSyncAt) return;
    seen.current = me.lastSyncAt;
    void refresh();
  });
}

export function useSync() {
  const client = useQueryClient();
  const markSyncing = () => {
    client.setQueryData<Me>(keys.me, (me) => me && { ...me, syncing: true });
    return client.invalidateQueries({ queryKey: keys.me });
  };
  return useMutation({
    mutationFn: api.sync,
    onSuccess: markSyncing,
    // Already running is as good as started; a disconnected inbox shows its banner once the profile reloads.
    onError: (error) =>
      error instanceof ApiError && error.code === "sync_in_progress"
        ? markSyncing()
        : client.invalidateQueries({ queryKey: keys.me }),
  });
}

export function useCreateApplication() {
  const refresh = useRefreshData();
  return useMutation({
    mutationFn: (input: Partial<ApplicationInput> & { company: string }) => api.createApplication(input),
    onSuccess: refresh,
  });
}

export function useUpdateApplication(id: string) {
  const refresh = useRefreshData();
  return useMutation({
    mutationFn: (patch: Partial<ApplicationInput>) => api.updateApplication(id, patch),
    onSettled: refresh,
  });
}

export function useDeleteApplication() {
  const refresh = useRefreshData();
  return useMutation({ mutationFn: api.deleteApplication, onSuccess: refresh });
}

export function useRevertEvent() {
  const refresh = useRefreshData();
  // A conflict means the timeline on screen is stale, so reload it either way.
  return useMutation({ mutationFn: api.revertEvent, onSettled: refresh });
}

export function useResolveReview() {
  const refresh = useRefreshData();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: ResolveAction }) => api.resolveReview(id, action),
    onSettled: refresh,
  });
}

export function useSignOut() {
  const client = useQueryClient();
  return useMutation({ mutationFn: api.logout, onSuccess: () => client.resetQueries() });
}

export function useDeleteAccount() {
  const client = useQueryClient();
  return useMutation({ mutationFn: api.deleteAccount, onSuccess: () => client.resetQueries() });
}

/** `value`, once it has stopped changing for `delay` ms. */
export function useDebounced<T>(value: T, delay = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/** Re-renders on an interval, so relative times ("2m ago") stay current. */
export function useTick(ms = 30_000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}
