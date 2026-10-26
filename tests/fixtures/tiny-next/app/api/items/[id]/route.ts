import { getItem } from '../../../../lib/items.ts';
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return Response.json({ item: getItem(id) });
}
