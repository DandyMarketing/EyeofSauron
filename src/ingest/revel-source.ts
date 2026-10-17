/**
 * What a day's row in daily_operations is labelled once Revel's file has been
 * loaded into it. Pure and on its own, so it is tested without a database.
 *
 * A day the Monday board reached first is 'monday'; Revel arriving later makes
 * it 'both', the state the board reaches when Revel was there first. Left as
 * 'monday', the next board sync writes the board's sales back over Revel's
 * (BUILD_LOG 6.4).
 */
export function sourceAfterRevel(existing: string | null | undefined): 'revel' | 'both' {
  return existing === 'monday' || existing === 'both' ? 'both' : 'revel';
}
