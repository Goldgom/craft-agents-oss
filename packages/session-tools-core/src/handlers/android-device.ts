import type { SessionToolContext } from '../context.ts';
import { errorResponse, successResponse } from '../response.ts';
import type { ToolResult } from '../types.ts';

export interface AndroidPermissionArgs {
  action: 'status' | 'request';
  permission?: 'camera' | 'microphone' | 'notifications' | 'photos' | 'videos' | 'audio' | 'location' | 'contacts' | 'calendar';
  reason?: string;
}

export interface AndroidAdbArgs {
  action: 'status' | 'shell';
  command?: string;
  reason?: string;
}

function format(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export async function handleAndroidPermission(
  ctx: SessionToolContext,
  args: AndroidPermissionArgs,
): Promise<ToolResult> {
  if (!ctx.androidPermissionFn) {
    return errorResponse('No connected Android client provides permission management.');
  }
  if (args.action === 'request' && !args.permission) {
    return errorResponse('permission is required when action=request');
  }
  if (args.action === 'request' && !args.reason?.trim()) {
    return errorResponse('reason is required so the user can make an informed permission decision');
  }
  try {
    return successResponse(format(await ctx.androidPermissionFn(args)));
  } catch (error) {
    return errorResponse(`Android permission request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function handleAndroidAdb(
  ctx: SessionToolContext,
  args: AndroidAdbArgs,
): Promise<ToolResult> {
  if (!ctx.androidAdbFn) {
    return errorResponse('No connected Android client provides network ADB.');
  }
  if (args.action === 'shell' && !args.command?.trim()) {
    return errorResponse('command is required when action=shell');
  }
  if (args.action === 'shell' && !args.reason?.trim()) {
    return errorResponse('reason is required and will be shown in the per-command confirmation dialog');
  }
  try {
    return successResponse(format(await ctx.androidAdbFn(args)));
  } catch (error) {
    return errorResponse(`Android ADB request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
