export { RPC2Client } from "./client";
export { RPC2ConnectionState } from "./types";
export type {
  JSONRPC2Request,
  JSONRPC2Response,
  JSONRPC2SuccessResponse,
  JSONRPC2ErrorResponse,
  JSONRPC2Error,
  JSONRPC2BatchRequest,
  JSONRPC2BatchResponse,
  JSONRPC2ErrorCodeType,
  RPC2ConnectionStateType,
  RPC2ConnectionOptions,
  RPC2CallOptions,
  RPC2EventListeners,
  RPC2NodeData,
  RPC2NodeStatus,
  RPC2StatusRecord,
  RPC2PingRecord,
  RPC2PingTask,
  RPC2BasicInfo,
  RPC2PingStat,
} from "./types";

import { MonitorRPC2Client } from "@/monitor/rpc-client";

/**
 * Module-level singleton — shared data connection for the entire app.
 * 极简探针（Monitor）移植：这里换成 Monitor 版实现（REST + /api/ws 实时帧），
 * 对外接口与原 RPC2Client 相同，调用方无需改动。
 */
export const rpc2Client = new MonitorRPC2Client();
