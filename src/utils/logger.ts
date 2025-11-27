export const Logger = {
    info(message: string, ...args: any[]) {
        const timestamp = new Date().toISOString();
        console.log(`[INFO]  ${timestamp} | ${message}`, ...args);
    },

    warn(message: string, ...args: any[]) {
        const timestamp = new Date().toISOString();
        console.warn(`[WARN]  ${timestamp} | ${message}`, ...args);
    },

    error(message: string | Error, ...args: any[]) {
        const timestamp = new Date().toISOString();
        if (message instanceof Error) {
            console.error(`[ERROR] ${timestamp} | ${message.message}`, message.stack, ...args);
        } else {
            console.error(`[ERROR] ${timestamp} | ${message}`, ...args);
        }
    },

    debug(message: string, ...args: any[]) {
        const timestamp = new Date().toISOString();
        console.log(`[DEBUG] ${timestamp} | ${message}`, ...args);
    },

};