import type { SQL } from '../../core/database.js';

// Metadata only: the same ordered, accessible images drive the editor and
// generation admission checks. Object bytes are loaded only by background jobs.
export async function artworkDetails(sql:SQL,t:string,ids:string[]) {
 if(!ids.length)return [];
 return (await sql.query(`SELECT a.*,ar.name AS artist,
 coalesce((SELECT jsonb_agg(m.id ORDER BY am.position,m.id) FROM app.artwork_media am JOIN app.media m ON m.tenant_id=am.tenant_id AND m.id=am.media_id
 WHERE am.tenant_id=a.tenant_id AND am.artwork_id=a.id AND m.state='ready' AND m.deleted_at IS NULL AND m.space_id IS NULL AND m.mime_type LIKE 'image/%'),'[]'::jsonb) AS media_ids
 FROM app.artworks a LEFT JOIN app.artists ar ON ar.tenant_id=a.tenant_id AND ar.id=a.artist_id WHERE a.tenant_id=$1 AND a.id=ANY($2::uuid[]) AND a.archived_at IS NULL`,[t,ids])).rows.sort((a,b)=>ids.indexOf(a.id)-ids.indexOf(b.id));
}

export function catalogArtwork(row:Record<string,any>) {
 const ref=(id:string|undefined)=>id?`/api/files/${id}`:undefined;
 return {...row,images:row.media_ids.map((id:string)=>ref(id)),image:ref(row.display_media_id||row.media_ids[0]),bannerImage:ref(row.banner_media_id||row.display_media_id||row.media_ids[0])};
}
