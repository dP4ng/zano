export const SERVER_DATA_CHANGED_EVENT = "zano:server-data-changed";

export interface ServerDataChangedDetail {
  serverId: string;
  resource?: "agents" | "channels" | "members";
}

export function notifyServerDataChanged(detail: ServerDataChangedDetail) {
  window.dispatchEvent(
    new CustomEvent<ServerDataChangedDetail>(SERVER_DATA_CHANGED_EVENT, {
      detail,
    })
  );
}

export function subscribeServerDataChanged(
  serverId: string,
  handler: (detail: ServerDataChangedDetail) => void
) {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<ServerDataChangedDetail>).detail;
    if (detail?.serverId === serverId) handler(detail);
  };

  window.addEventListener(SERVER_DATA_CHANGED_EVENT, listener);
  return () => window.removeEventListener(SERVER_DATA_CHANGED_EVENT, listener);
}
