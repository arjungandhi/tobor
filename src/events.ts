// In-process typed event bus. `/api/events` forwards every event; services emit, nothing persists (lossy by design).
import type { NodeEvent, NodeEventType } from "./api/types.js";

/** The event payload for one `type`. */
export type EventOf<K extends NodeEventType> = Extract<NodeEvent, { type: K }>;

type Listener<E> = (event: E) => void;

/** Synchronous fan-out of `NodeEvent`s. A throwing listener is reported and never stops delivery to the others. */
export class EventBus {
	private readonly byType = new Map<NodeEventType, Set<Listener<NodeEvent>>>();
	private readonly any = new Set<Listener<NodeEvent>>();

	constructor(private readonly onListenerError: (error: unknown, event: NodeEvent) => void = defaultOnError) {}

	/** Subscribe to one event type; returns an unsubscribe function. */
	on<K extends NodeEventType>(type: K, listener: Listener<EventOf<K>>): () => void {
		let set = this.byType.get(type);
		if (!set) this.byType.set(type, (set = new Set()));
		const l = listener as Listener<NodeEvent>;
		set.add(l);
		return () => {
			set.delete(l);
		};
	}

	/** Subscribe to every event; returns an unsubscribe function. */
	onAny(listener: Listener<NodeEvent>): () => void {
		this.any.add(listener);
		return () => {
			this.any.delete(listener);
		};
	}

	/** Deliver `event` to its type's listeners, then to `onAny` listeners. */
	emit(event: NodeEvent): void {
		for (const l of this.byType.get(event.type) ?? []) this.call(l, event);
		for (const l of this.any) this.call(l, event);
	}

	private call(listener: Listener<NodeEvent>, event: NodeEvent): void {
		try {
			listener(event);
		} catch (error) {
			this.onListenerError(error, event);
		}
	}
}

function defaultOnError(error: unknown, event: NodeEvent): void {
	console.error(`event listener failed on ${event.type}:`, error);
}
