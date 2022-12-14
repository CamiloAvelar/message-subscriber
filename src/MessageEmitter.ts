import { EventEmitter } from 'node:events';

const eventEmitter = new EventEmitter();
const originalOn = eventEmitter.on;

export class MessageEmitter extends EventEmitter {
  constructor() {
    super();
  }

  public on(...args: [eventName: string | symbol, listener: (...args: any[]) => void]): any {
    if (args[0] === 'message') {
      const oldFn: Function = args[1];

      args[1] = async function (...args: any) {
        try {
          var response = await oldFn.apply(this, args);
        } finally {
          //@ts-ignore
          this.emit(`finished ${args[0].id}`);
          //@ts-ignore
          this.emit('finished', args[0].id);
        }

        return response;
      };
    }

    return originalOn.apply(this, args);
  }
}