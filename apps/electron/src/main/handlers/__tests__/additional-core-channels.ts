import { RPC_CHANNELS } from '@craft-agent/shared/protocol'

/** Core domains added after the original registration fixtures. Keep event
 * channels out: these are RPC request handlers, not pushed notifications. */
export const ADDITIONAL_CORE_CHANNELS = [
  RPC_CHANNELS.agents.LIST,
  RPC_CHANNELS.agents.SAVE,
  RPC_CHANNELS.agents.DELETE,
  RPC_CHANNELS.agents.GENERATE,
  RPC_CHANNELS.catalog.LIST_TOOLS,
  RPC_CHANNELS.catalog.LIST_GUIDES,
  RPC_CHANNELS.collaborations.CREATE,
  RPC_CHANNELS.collaborations.GET,
  RPC_CHANNELS.collaborations.LIST,
  RPC_CHANNELS.collaborations.LIST_CANDIDATES,
  RPC_CHANNELS.collaborations.LIST_WORKSPACES,
  RPC_CHANNELS.collaborations.REQUEST,
  RPC_CHANNELS.collaborations.REPORT,
  RPC_CHANNELS.collaborations.UPDATE_BOARD,
  RPC_CHANNELS.collaborations.PUT_FILE,
  RPC_CHANNELS.collaborations.GET_FILE,
  RPC_CHANNELS.collaborations.RETRY_DELIVERY,
  RPC_CHANNELS.collaborations.END,
  RPC_CHANNELS.studio.EXPORT_VISIO,
  RPC_CHANNELS.studio.GENERATE_IMAGE,
  RPC_CHANNELS.studio.GENERATE_MIND_MAP,
  RPC_CHANNELS.studio.ASSIST_CANVAS,
  RPC_CHANNELS.tools.GET_REQUIRE_SOURCE_GUIDE,
  RPC_CHANNELS.tools.SET_REQUIRE_SOURCE_GUIDE,
] as const
