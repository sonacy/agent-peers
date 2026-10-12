/** In-app paths (below the `/app` base). The rooms screen reads `new` / `find` to open its dialog or search. */
export const PATHS = {
  home: '/',
  rooms: '/rooms',
  room: (roomId: string) => `/rooms/${encodeURIComponent(roomId)}`,
  asks: '/asks',
  login: '/login',
  gallery: '/_gallery',
} as const

export const CREATE_ROOM_HREF = '/rooms?new=1'
export const FIND_ROOM_HREF = '/rooms?find=1'
