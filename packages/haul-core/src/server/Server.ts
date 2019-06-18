import { EnvOptions } from '../config/types';
import { Assign } from 'utility-types';
import Hapi from '@hapi/hapi';
import http from 'http';
import { EventEmitter } from 'events';
import ws from 'ws';
// @ts-ignore
import Compiler from '@haul-bundler/core-legacy/build/compiler/Compiler';
import { terminal } from 'terminal-kit';
import Runtime from '../runtime/Runtime';
import setupDevtoolRoutes from './setupDevtoolRoutes';
import setupCompilerRoutes from './setupCompilerRoutes';
import renderUI from './renderUI';
import {
  EAGER_COMPILATION_REQUEST,
  COMPILATION_START,
  COMPILATION_PROGRESS,
  COMPILATION_FAILED,
  COMPILATION_FINISHED,
  REQUEST_FAILED,
  RESPONSE_COMPLETE,
  RESPONSE_FAILED,
  LOG,
} from './events';
import setupLiveReload from './setupLiveReload';
import setupSymbolication from './setupSymbolication';
import createWebsocketProxy from './websocketProxy';
import WebSocketDebuggerProxy from './WebSocketDebuggerProxy';

type ServerEnvOptions = Assign<
  Pick<EnvOptions, 'dev' | 'minify' | 'assetsDest' | 'root'>,
  { noInteractive: boolean; eager: string[]; bundleNames: string[] }
>;

export default class Server {
  compiler: any;
  serverEvents = new EventEmitter();
  server: Hapi.Server | undefined;
  httpServer: http.Server = http.createServer();
  resetConsole = () => {};

  constructor(
    private runtime: Runtime,
    private configPath: string,
    private options: ServerEnvOptions
  ) {}

  createCompiler() {
    const compiler = new Compiler({
      configPath: this.configPath,
      configOptions: this.options,
    });

    compiler.on(
      Compiler.Events.BUILD_START,
      ({ platform }: { platform: string }) => {
        this.serverEvents.emit(COMPILATION_START, { platform });
      }
    );

    compiler.on(
      Compiler.Events.BUILD_PROGRESS,
      ({ progress, platform }: { platform: string; progress: number }) => {
        this.serverEvents.emit(COMPILATION_PROGRESS, { platform, progress });
      }
    );

    compiler.on(
      Compiler.Events.BUILD_FAILED,
      ({ platform, message }: { platform: string; message: string }) => {
        this.serverEvents.emit(COMPILATION_FAILED, { platform, message });
      }
    );

    compiler.on(
      Compiler.Events.BUILD_FINISHED,
      ({ platform, errors }: { platform: string; errors: string[] }) => {
        this.serverEvents.emit(COMPILATION_FINISHED, { platform, errors });
      }
    );

    return compiler;
  }

  attachProcessEventsListeners() {
    const createListener = (exitCode: number) => (error: any) => {
      this.exit(exitCode, error);
    };

    process.on('uncaughtException', createListener(1));
    process.on('unhandledRejection', createListener(1));
    process.on('SIGINT', createListener(0));
    process.on('SIGTERM', createListener(2));
  }

  exit(exitCode: number, error: any | undefined) {
    this.resetConsole();
    if (error) {
      this.runtime.logger.error(error);
    }
    this.compiler.terminate();
    if (!this.options.noInteractive) {
      terminal.fullscreen(false); // switch back to main screen buffer
    }
    this.runtime.complete(exitCode);
  }

  async listen(host: string, port: number) {
    this.runtime.logger.proxy((level, ...args) => {
      this.serverEvents.emit(LOG, { level, args });
    });
    this.resetConsole = this.hijackConsole();
    this.compiler = this.createCompiler();
    this.attachProcessEventsListeners();

    const server = new Hapi.Server({
      port,
      host,
      router: {
        stripTrailingSlash: true,
      },
    });

    const webSocketServer = new ws.Server({ server: server.listener });
    const webSocketProxy = createWebsocketProxy(
      webSocketServer,
      '/debugger-proxy'
    );
    const debuggerProxy = new WebSocketDebuggerProxy(
      this.runtime,
      webSocketProxy
    );

    await server.register(require('@hapi/inert'));

    server.events.on(
      { name: 'request', channels: 'error' },
      (request, event) => {
        this.serverEvents.emit(REQUEST_FAILED, { request, event });
      }
    );

    server.events.on('response', request => {
      if ('statusCode' in request.response) {
        if (request.response.statusCode < 400) {
          this.serverEvents.emit(RESPONSE_COMPLETE, { request });
        } else {
          this.serverEvents.emit(RESPONSE_FAILED, { request });
        }
      }
    });

    setupSymbolication(this.runtime, server, {
      bundleNames: this.options.bundleNames,
    });
    setupLiveReload(this.runtime, server, this.compiler);
    setupDevtoolRoutes(this.runtime, server, {
      isDebuggerConnected: () => debuggerProxy.isDebuggerConnected(),
    });
    setupCompilerRoutes(this.runtime, server, this.compiler, {
      port,
      bundleNames: this.options.bundleNames,
    });

    await server.start();
    if (!this.options.noInteractive) {
      terminal.fullscreen(true); // Switch to alternate screen buffer
      renderUI(this.serverEvents, { port, host });
    }

    this.options.eager.forEach(platform => {
      this.serverEvents.emit(EAGER_COMPILATION_REQUEST, { platform });
      this.compiler.emit(Compiler.Events.REQUEST_BUNDLE, {
        filename: `/index.${platform}.bundle`, // NOTE: maybe the entry bundle is arbitrary
        platform,
        callback() {},
      });
    });
  }

  hijackConsole() {
    if (this.options.noInteractive) {
      return () => {};
    }

    /* eslint-disable no-console */
    const log = console.log;
    const error = console.error;

    console.log = (...args) => {
      this.serverEvents.emit(LOG, { level: 'info', args });
    };
    console.error = (...args) => {
      this.serverEvents.emit(LOG, { level: 'error', args });
    };

    return () => {
      console.log = log;
      console.error = error;
    };
    /* eslint-enable no-console */
  }
}