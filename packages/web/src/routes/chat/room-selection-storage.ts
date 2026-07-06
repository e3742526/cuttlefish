const SELECTED_ROOM_STORAGE_KEY = "cuttlefish-chat-selected-room"

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null
  return window.localStorage
}

export function loadSelectedRoomId(): string | null {
  try {
    const stored = getStorage()?.getItem(SELECTED_ROOM_STORAGE_KEY)
    const roomId = stored?.trim()
    return roomId ? roomId : null
  } catch {
    return null
  }
}

export function saveSelectedRoomId(roomId: string): void {
  try {
    getStorage()?.setItem(SELECTED_ROOM_STORAGE_KEY, roomId)
  } catch {}
}

export function clearSelectedRoomId(): void {
  try {
    getStorage()?.removeItem(SELECTED_ROOM_STORAGE_KEY)
  } catch {}
}
