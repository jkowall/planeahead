/**
 * Messages about flight mutations the server refused after the screen that made them moved on:
 * an add the outbox drained later (offline at the time, or the sheet was closed) that answered
 * 403 `cap_exceeded` or 404 `flight_not_found`. In memory only: the optimistic row is already
 * gone when the notice is raised, and a message about a refusal from a previous launch would
 * describe a row the user no longer sees.
 *
 * The add sheet reads the notice for its own subscription id when its drain finishes and shows
 * it in place (then clears it); anything left is shown on the home screen until dismissed.
 */

import { create } from 'zustand';

export interface FlightNotice {
  /** The subscription id of the refused add (the optimistic row's id). */
  readonly id: string;
  readonly message: string;
}

interface FlightNoticesState {
  readonly notices: readonly FlightNotice[];
  readonly push: (notice: FlightNotice) => void;
  readonly dismiss: (id: string) => void;
  readonly take: (id: string) => FlightNotice | null;
  readonly clear: () => void;
}

export const useFlightNotices = create<FlightNoticesState>()((set, get) => ({
  notices: [],
  push: (notice) => {
    set((state) => ({
      notices: [...state.notices.filter((existing) => existing.id !== notice.id), notice],
    }));
  },
  dismiss: (id) => {
    set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) }));
  },
  take: (id) => {
    const found = get().notices.find((notice) => notice.id === id) ?? null;
    if (found !== null) {
      get().dismiss(id);
    }
    return found;
  },
  clear: () => {
    set({ notices: [] });
  },
}));
