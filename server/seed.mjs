export const plans = {
  Starter: { seats: 1, artworks: 30, catalogs: 5, storageMB: 25, rooms: 0, generations: 10, features: ['inventory', 'collections', 'catalogs', 'customers', 'inquiries', 'tasks'] },
  Studio: { seats: 3, artworks: 250, catalogs: 40, storageMB: 100, rooms: 2, generations: 60, features: ['inventory', 'collections', 'catalogs', 'customers', 'inquiries', 'tasks', 'invoices', 'payments', 'reservations', 'deliveries', 'reports', 'rooms'] },
  Team: { seats: 10, artworks: 1000, catalogs: 150, storageMB: 300, rooms: 15, generations: 200, features: ['inventory', 'collections', 'catalogs', 'customers', 'inquiries', 'tasks', 'invoices', 'payments', 'reservations', 'deliveries', 'reports', 'conversations', 'rooms', 'audit', 'import'] },
  Business: { seats: 30, artworks: 5000, catalogs: 500, storageMB: 1000, rooms: 100, generations: 1000, features: ['inventory', 'collections', 'catalogs', 'customers', 'inquiries', 'tasks', 'invoices', 'payments', 'reservations', 'deliveries', 'reports', 'conversations', 'rooms', 'audit', 'import'] }
};
const day = 86400000;
export function makeSeed(now = Date.now()) {
  const t = n => new Date(now + n * day).toISOString();
  const wrap = (items, workspaceId = 'vayu') => items.map(x => ({ createdAt: t(-3), updatedAt: t(-1), createdBy: 'admin', workspaceId, ...x }));
  return {
    schema: 1,
    users: [
      { id: 'admin', name: 'Aarav Mehta', email: 'aarav@example.test', workspaceId: 'vayu', role: 'admin', initials: 'AM' },
      { id: 'member', name: 'Mira Shah', email: 'mira@example.test', workspaceId: 'vayu', role: 'member', initials: 'MS' },
      { id: 'client', name: 'Rhea Kapoor', email: 'rhea@example.test', workspaceId: 'vayu', role: 'guest', initials: 'RK' },
      { id: 'other', name: 'Independent Studio', email: 'studio@example.test', workspaceId: 'other', role: 'admin', initials: 'IS' }
    ],
    workspaces: [
      { id: 'vayu', name: 'Vayu Gallery', plan: 'Business', subscription: 'active', renewalAt: t(30), generations: 0, generationMonth: t(0).slice(0,7) },
      { id: 'other', name: 'Independent Studio', plan: 'Starter', subscription: 'active', renewalAt: t(30), generations: 0, generationMonth: t(0).slice(0,7) }
    ],
    artworks: wrap([
      { id: 'a1', title: 'The quiet between', artist: 'Ananya Sen', medium: 'Acrylic on canvas', dimensions: '90 × 120 cm', price: 85000, status: 'Available', image: '/art/quiet.svg', location: 'Gallery · Wall 01', description: 'An exploration of stillness, in earth and indigo.', year: '2026' },
      { id: 'a2', title: 'Soft geometry', artist: 'Kabir Rao', medium: 'Mixed media', dimensions: '80 × 100 cm', price: 64000, status: 'Reserved', image: '/art/geometry.svg', location: 'Gallery · Wall 02', description: 'Playful forms finding a delicate balance.', year: '2026' },
      { id: 'a3', title: 'A place to return', artist: 'Meera Iyer', medium: 'Oil on canvas', dimensions: '100 × 120 cm', price: 125000, status: 'Available', image: '/art/landscape.svg', location: 'Studio · Rack 03', description: 'A landscape held somewhere between memory and imagination.', year: '2025' },
      { id: 'a4', title: 'Earthbound', artist: 'Dev Malhotra', medium: 'Textured acrylic', dimensions: '70 × 90 cm', price: 48000, status: 'Available', image: '/art/earth.svg', location: 'Gallery · Wall 04', description: 'Material, texture, and the warmth of the natural world.', year: '2026' },
      { id: 'a5', title: 'Blue hour', artist: 'Ananya Sen', medium: 'Acrylic on canvas', dimensions: '60 × 80 cm', price: 72000, status: 'Sold', image: '/art/blue.svg', location: 'Delivered', description: 'A study in the last light of the day.', year: '2025' },
      { id: 'a6', title: 'Almost a circle', artist: 'Kabir Rao', medium: 'Ink on paper', dimensions: '50 × 70 cm', price: 32000, status: 'Available', image: '/art/circle.svg', location: 'Studio · Drawer 02', description: 'An imperfect gesture, made complete.', year: '2026' }
    ]),
    collections: wrap([{ id: 'col1', title: 'A quieter kind of living', description: 'Six perspectives on space, form, and feeling.', artworkIds: ['a1', 'a2', 'a3', 'a4'] }, { id: 'col2', title: 'Studies in blue', description: 'An ode to stillness.', artworkIds: ['a1','a5'] }]),
    catalogs: wrap([{ id: 'cat1', title: 'Spaces for stillness', description: 'A considered selection for the modern home.', artworkIds: ['a1','a2','a3'], theme: 'Ivory', source: 'Studio draft', versions: [], cover: '/art/quiet.svg' }]),
    customers: wrap([{ id: 'c1', title: 'Rhea Kapoor', email: 'rhea@example.test', phone: '+91 90000 00001', address: '12, Palm Avenue', city: 'Mumbai', region: 'Maharashtra', postal: '400001', country: 'India', notes: 'Interested in work for a new living space.' }, { id: 'c2', title: 'Arjun Nair', email: 'arjun@example.test', phone: '+91 90000 00002', address: '8, Garden Road', city: 'Bengaluru', region: 'Karnataka', postal: '560001', country: 'India', notes: 'Prefers contemporary abstract work.' }]),
    inquiries: wrap([{ id: 'q1', title: 'Art for a new home', customerId: 'c1', artworkIds: ['a1','a2'], status: 'Interested', source: 'Referral', assignee: 'member', notes: 'Send a selection in warm, neutral tones.', address: '12, Palm Avenue', city: 'Mumbai', region: 'Maharashtra', postal: '400001', country: 'India', attachments: [] }, { id: 'q2', title: 'Office collection', customerId: 'c2', artworkIds: ['a3','a4'], status: 'New', source: 'Email', assignee: 'admin', notes: 'Looking for two statement pieces.', address: '8, Garden Road', city: 'Bengaluru', region: 'Karnataka', postal: '560001', country: 'India', attachments: [] }]),
    tasks: wrap([{ id: 't1', title: 'Send Rhea the updated selection', inquiryId: 'q1', assignee: 'admin', dueAt: t(0).slice(0,10), status: 'Open' }, { id: 't2', title: 'Confirm dimensions for the office', inquiryId: 'q2', assignee: 'member', dueAt: t(1).slice(0,10), status: 'Open' }]),
    reservations: wrap([{ id: 'res1', title: 'Soft geometry · Rhea Kapoor', artworkId: 'a2', customerId: 'c1', inquiryId: 'q1', expiresAt: t(3), status: 'Active' }]),
    invoices: wrap([{ id: 'inv1', title: 'INV-2026-001', customerId: 'c2', inquiryId: '', artworkIds: ['a5'], items: [{ artworkId: 'a5', title: 'Blue hour', price: 72000 }], subtotal: 72000, taxRate: 0, total: 72000, status: 'Paid' }]),
    payments: wrap([{ id: 'p1', title: 'Blue hour · payment', invoiceId: 'inv1', amount: 72000, status: 'Paid', method: 'Sample bank transfer', verifiedAt: t(-1) }]),
    deliveries: wrap([{ id: 'del1', title: 'Blue hour · delivery', invoiceId: 'inv1', status: 'Delivered', tracking: 'SAMPLE-104', address: '8, Garden Road, Bengaluru', notes: 'Received at reception.', attachments: [] }]),
    conversations: wrap([{ id: 'dm1', title: 'Mira Shah', kind: 'direct', memberIds: ['admin','member'] }, { id: 'gr1', title: 'Gallery team', kind: 'group', memberIds: ['admin','member'] }]),
    rooms: wrap([{ id: 'room1', title: 'The Palm residence', description: 'A private selection for Rhea’s new home.', memberIds: ['admin','member','client'], artworkIds: ['a1','a2','a4'], catalogIds: ['cat1'], attachments: [], status: 'Active' }, { id: 'room2', title: 'Office project', description: 'Planning the new collection.', memberIds: ['member'], artworkIds: ['a3'], catalogIds: [], attachments: [], status: 'Active', createdBy: 'member' }]),
    messages: wrap([{ id: 'm1', containerType: 'conversations', containerId: 'dm1', senderId: 'member', text: 'The new selection is ready. Shall we put together a catalog for Rhea?', readBy: ['member'] }, { id: 'm2', containerType: 'rooms', containerId: 'room1', senderId: 'client', text: 'I love these warm tones. Could we see Soft geometry in the selection?', readBy: ['client'] }]),
    approvals: [], files: [], shares: [], drafts: [],
    notifications: wrap([{ id: 'n1', userId: 'admin', title: 'Rhea left a message in The Palm residence', route: 'rooms', targetId: 'room1', read: false }]),
    audit: [{ id: 'ev1', workspaceId: 'vayu', actorId: 'admin', actorName: 'Aarav Mehta', action: 'workspace.created', entity: 'workspaces', entityId: 'vayu', title: 'Vayu Gallery', at: t(-4), changes: [], outcome: 'success', requestId: 'sample-event' }]
  };
}
