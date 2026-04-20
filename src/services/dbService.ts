import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const createSupabaseClient = (): SupabaseClient | null => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }

  return createClient(supabaseUrl, supabaseAnonKey);
};

export const db = createSupabaseClient();
