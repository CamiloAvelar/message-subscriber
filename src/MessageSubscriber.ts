import { MessageEmitter } from './MessageEmitter';
import { ProcessorQueue } from './ProcessorQueue';
import { MessageAdapter, Message } from './messageAdapters';
import { whilst, times } from 'async';
import { wait } from './utils';

export type MessageSubscriberParams = {
  messageAdapter: MessageAdapter
  parallelism: number
  refreshInterval?: number
};

export class MessageSubscriber extends MessageEmitter {
  private _running: boolean;
  private _paused: boolean;
  private _stoped: boolean;
  private _messageAdapter: MessageAdapter;
  private _maxNumberOfMessages: number;
  private _maxMessages: number;
  private _refreshInterval: number;
  private _processorQueue: ProcessorQueue;

  constructor(params: MessageSubscriberParams) {
    super();
    this._messageAdapter = params.messageAdapter;
    this._processorQueue = new ProcessorQueue({
      parallelism: params.parallelism,
      queueFunction: this._queueFunction.bind(this),
    });

    this._maxMessages = Math.ceil(params.parallelism * 1.10);
    this._refreshInterval = Object.prototype.hasOwnProperty.call(params, 'refreshInterval') ? params.refreshInterval as number : 30;
    this._maxNumberOfMessages = this._messageAdapter.maxNumberOfMessages || 10;
    this._running = false;
    this._paused = false;
    this._stoped = false;
    this._decorateDelete();
  }

  get length() {
    return this._processorQueue.length;
  }

  public async gracefulShutdown() {
    this._running = false;

    await this._processorQueue.drain();
    this.emit('drained');
  }

  public stop() {
    this._processorQueue.stop();
    this._running = false;
  }

  public pause() {
    this._paused = true;
    this._processorQueue.pause();
    this.emit('paused');
  }

  public resume() {
    this._paused = false;
    this._processorQueue.resume();
    this.emit('resumed');
  }

  public start() {
    if (!this._hasMessageListener()) {
      throw new Error('Message listener should be implemented before start call.');
    }

    if (this._stoped) {
      throw new Error('The subscriber is in stopped state, cannot call start again.');
    }

    this._running = true;

    whilst(
      this._checkRunning.bind(this),
      this._getMessages.bind(this),
      this._stopRunning.bind(this)
    );
  }

  private async _checkRunning() {
    return this._running;
  }

  private async _getMessages() {
    if (this._paused) {
      await wait(100);
      return;
    }

    const idleSlots = this._maxMessages - (this._processorQueue.length);
    const numberOfRequests = Math.ceil(idleSlots / this._maxNumberOfMessages);

    if (numberOfRequests > 0) {
      await times(numberOfRequests, this._requestMessages().bind(this));
    } else {
      await wait(10);
    }
  }

  private _requestMessages() {
    return async () => {
      try {
        const messages = await this._messageAdapter.receive(this._maxNumberOfMessages);

        if (!messages.length) {
          this.emit('empty');
          await wait(10);
          return;
        }

        this._startRefreshes(messages);

        this._processorQueue.push(messages);
      } catch (err) {
        await wait(10);
        this.emit('error', err);
      }
    };
  }

  private async _stopRunning(err?: any) {
    this._stoped = true;

    this.emit('stoped');

    if (err) {
      this.emit('error', err);
    }
  }

  private _startRefreshes(messages: Message[]) {
    if (this._refreshInterval > 0) {
      messages.forEach(this._startRefresh.bind(this));
    }
  }

  private _startRefresh(message: Message) {
    const refreshInterval = this._refreshInterval;
    const interval = setInterval(async () => {
      try {
        await message.delay(refreshInterval);
      } catch (err) {
        await wait(100);
        this.emit('error', err);
      }
    }, (refreshInterval * 0.7) * 1000);

    const self = this;

    function finishedCallback() {
      clearInterval(interval);
      self.removeListener(`deleted ${message.receipt}`, deletedCallback);
    }

    function deletedCallback() {
      clearInterval(interval);
      self.removeListener(`finished ${message.id}`, finishedCallback);
    }

    this.once(`finished ${message.id}`, finishedCallback);
    this.once(`deleted ${message.receipt}`, deletedCallback);

    interval.unref();
  }

  private _decorateDelete() {
    const originalDelete = this._messageAdapter.delete;
    const self = this;

    this._messageAdapter.delete = async function (...args: any) {
      const response = await originalDelete.apply(this, args);

      self.emit(`deleted ${args[0]}`);
      self.emit('deleted', args[0]);

      return response;
    };
  }

  private _hasMessageListener(): boolean {
    return this.listeners('message').length > 0;
  }

  private async _queueFunction(message: Message): Promise<void> {
    this.emit('message', message);
    return new Promise((resolve) => {
      this.once(`finished ${message.id}`, () => {
        resolve();
      });
    });
  }
}