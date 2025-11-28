declare const __DEV__: boolean;

export const Logger = {
    info(message: string, ...args: any[]) {
        if (__DEV__) {
            const ts = new Date().toISOString();
            console.log(`[INFO]  ${ts} | ${message}`, ...args);
        }
    },

    warn(message: string, ...args: any[]) {
        if (__DEV__) {
            const ts = new Date().toISOString();
            console.warn(`[WARN]  ${ts} | ${message}`, ...args);
        }
    },

    error(message: string | Error, ...args: any[]) {
        if (__DEV__) {
            const ts = new Date().toISOString();
            if (message instanceof Error) {
                console.error(`[ERROR] ${ts} | ${message.message}`, message.stack, ...args);
            } else {
                console.error(`[ERROR] ${ts} | ${message}`, ...args);
            }
        }
    },

    debug(message: string, ...args: any[]) {
        if (__DEV__) {
            const ts = new Date().toISOString();
            console.log(`[DEBUG] ${ts} | ${message}`, ...args);
        }
    },
};