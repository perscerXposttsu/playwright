/**
 * Copyright Microsoft Corporation. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import child_process from 'child_process';
import { EventEmitter } from 'events';
import type { ProcessInitParams } from './ipc';
import type { ProtocolResponse } from './process';

export type ProcessExitData = {
  unexpectedly: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
};

export class ProcessHost<InitParams> extends EventEmitter {
  private process!: child_process.ChildProcess;
  private _didSendStop = false;
  private _didFail = false;
  private didExit = false;
  private _runnerScript: string;
  private _lastMessageId = 0;
  private _callbacks = new Map<number, { resolve: (result: any) => void, reject: (error: Error) => void }>();

  constructor(runnerScript: string) {
    super();
    this._runnerScript = runnerScript;
  }

  async doInit(params: InitParams) {
    this.process = child_process.fork(require.resolve('./process'), {
      detached: false,
      env: {
        FORCE_COLOR: '1',
        DEBUG_COLORS: '1',
        PW_PROCESS_RUNNER_SCRIPT: this._runnerScript,
        ...process.env
      },
      // Can't pipe since piping slows down termination for some reason.
      stdio: ['ignore', 'ignore', process.env.PW_RUNNER_DEBUG ? 'inherit' : 'ignore', 'ipc']
    });
    this.process.on('exit', (code, signal) => {
      this.didExit = true;
      this.emit('exit', { unexpectedly: !this._didSendStop, code, signal } as ProcessExitData);
    });
    this.process.on('error', e => {});  // do not yell at a send to dead process.
    this.process.on('message', (message: any) => {
      if (message.method === '__dispatch__') {
        const { id, error, method, params, result } = message.params as ProtocolResponse;
        if (id && this._callbacks.has(id)) {
          const { resolve, reject } = this._callbacks.get(id)!;
          this._callbacks.delete(id);
          if (error)
            reject(new Error(error));
          else
            resolve(result);
        } else {
          this.emit(method!, params);
        }
      } else {
        this.emit(message.method!, message.params);
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.process.once('exit', (code, signal) => reject(new Error(`process exited with code "${code}" and signal "${signal}" before it became ready`)));
      this.once('ready', () => resolve());
    });

    const processParams: ProcessInitParams = {
      stdoutParams: {
        rows: process.stdout.rows,
        columns: process.stdout.columns,
        colorDepth: process.stdout.getColorDepth?.() || 8
      },
      stderrParams: {
        rows: process.stderr.rows,
        columns: process.stderr.columns,
        colorDepth: process.stderr.getColorDepth?.() || 8
      },
    };

    this.send({ method: 'init', params: { ...processParams, ...params } });
  }

  protected sendMessage(message: { method: string, params?: any }) {
    const id = ++this._lastMessageId;
    this.send({
      method: '__dispatch__',
      params: { id, ...message }
    });
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, { resolve, reject });
    });
  }

  protected sendMessageNoReply(message: { method: string, params?: any }) {
    this.sendMessage(message).catch(() => {});
  }

  async stop(didFail?: boolean) {
    if (didFail)
      this._didFail = true;
    if (this.didExit)
      return;
    if (!this._didSendStop) {
      this.send({ method: 'stop' });
      this._didSendStop = true;
    }
    await new Promise(f => this.once('exit', f));
  }

  didFail() {
    return this._didFail;
  }

  didSendStop() {
    return this._didSendStop;
  }

  private send(message: { method: string, params?: any }) {
    // This is a great place for debug logging.
    this.process.send(message);
  }
}
