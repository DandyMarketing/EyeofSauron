import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabaseAdmin = createClient(url, serviceKey);

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  venues: Array<{ venue_id: string; slug: string; role: string }>;
  isOwner: boolean;
}

export async function validateSession(accessToken: string): Promise<SessionUser | null> {
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !user) return null;

  const { data: roles } = await supabaseAdmin
    .from('user_venue_roles')
    .select('venue_id, role, venues(slug)')
    .eq('user_id', user.id);

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('full_name')
    .eq('id', user.id)
    .maybeSingle();

  const isOwner = (roles ?? []).some((r: any) => r.role === 'owner');

  return {
    id: user.id,
    email: user.email!,
    fullName: profile?.full_name ?? '',
    venues: (roles ?? []).map((r: any) => ({
      venue_id: r.venue_id,
      slug: r.venues?.slug ?? '',
      role: r.role,
    })),
    isOwner,
  };
}

export async function listUsers() {
  const { data: profiles } = await supabaseAdmin
    .from('profiles')
    .select('id, email, full_name, created_at');

  const { data: allRoles } = await supabaseAdmin
    .from('user_venue_roles')
    .select('id, user_id, venue_id, role, venues(name, slug)');

  return (profiles ?? []).map((p: any) => ({
    id: p.id,
    email: p.email,
    full_name: p.full_name,
    created_at: p.created_at,
    roles: (allRoles ?? [])
      .filter((r: any) => r.user_id === p.id)
      .map((r: any) => ({
        id: r.id,
        venue_id: r.venue_id,
        venue_name: r.venues?.name ?? '',
        venue_slug: r.venues?.slug ?? '',
        role: r.role,
      })),
  }));
}

export async function inviteUser(email: string, fullName: string) {
  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName },
  });
  if (error) throw new Error(error.message);
  return data.user;
}

export async function assignRole(userId: string, venueId: string, role: string) {
  const { data, error } = await supabaseAdmin
    .from('user_venue_roles')
    .upsert({ user_id: userId, venue_id: venueId, role }, { onConflict: 'user_id,venue_id' })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function removeRole(roleId: string) {
  const { error } = await supabaseAdmin
    .from('user_venue_roles')
    .delete()
    .eq('id', roleId);
  if (error) throw new Error(error.message);
}

export { supabaseAdmin };
