import pino from 'pino';

const logLevel = process.env.LOG_LEVEL || 'info';
const nodeId = process.env.NODE_ID || 'unknown-node';

export const logger = pino({
  level: logLevel,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  },
  base: {
    nodeId
  }
});

export const setLoggerSlot = (slot: number) => {
  logger.bindings().slot = slot;
};
