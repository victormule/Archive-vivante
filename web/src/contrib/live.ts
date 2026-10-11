import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_KEY, SUPABASE_URL, TABLE } from "./config";
import type { Contribution } from "./types";

export interface LiveHandlers {
  insert: (row: Contribution) => void;
  remove: (id: string) => void;
  /** (Re)connexion établie : de quoi rattraper ce qui a été manqué entre-temps. */
  connected: () => void;
}

const COLUMNS = "id,created_at,author,message,media_kind,media_path,thumb_path,media_width,media_height";

/**
 * Contributions : lecture paginée et abonnement temps réel. La bibliothèque
 * Supabase n'est chargée qu'au premier usage (le volet n'existe que sur l'Event).
 */
export class ContributionSource {
  private client: Promise<SupabaseClient> | null = null;
  private channel: RealtimeChannel | null = null;

  private getClient(): Promise<SupabaseClient> {
    this.client ??= import("@supabase/supabase-js").then(({ createClient }) =>
      createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }),
    );
    return this.client;
  }

  /** Les plus récentes, ou celles d'avant `before` (date ISO), de la plus récente à la plus ancienne. */
  async list(limit: number, before?: string): Promise<Contribution[]> {
    const client = await this.getClient();
    let query = client.from(TABLE).select(COLUMNS).order("created_at", { ascending: false }).limit(limit);
    if (before) query = query.lt("created_at", before);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return (data ?? []) as Contribution[];
  }

  /** Celles postées après `after` (rattrapage après une coupure), des plus récentes aux plus anciennes. */
  async since(after: string): Promise<Contribution[]> {
    const client = await this.getClient();
    const { data, error } = await client.from(TABLE).select(COLUMNS).gt("created_at", after).order("created_at", { ascending: false }).limit(200);
    if (error) throw new Error(error.message);
    return (data ?? []) as Contribution[];
  }

  async subscribe(handlers: LiveHandlers): Promise<void> {
    if (this.channel) return;
    const client = await this.getClient();
    this.channel = client
      .channel("contributions")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: TABLE }, (payload) => handlers.insert(payload.new as Contribution))
      .on("postgres_changes", { event: "DELETE", schema: "public", table: TABLE }, (payload) => {
        const id = (payload.old as Partial<Contribution>).id;
        if (id) handlers.remove(id);
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") handlers.connected();
      });
  }

  async unsubscribe(): Promise<void> {
    const channel = this.channel;
    this.channel = null;
    if (channel) await (await this.getClient()).removeChannel(channel);
  }
}
