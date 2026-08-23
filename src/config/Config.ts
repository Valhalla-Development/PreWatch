import { z } from 'zod';
import { log } from '../utils/Console.js';

// Helper transforms for common patterns
const stringToBoolean = (val: string): boolean => val.toLowerCase() === 'true';
const stringToArray = (val: string): string[] =>
    val
        ? val
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
        : [];

const configSchema = z.object({
    // Required API URL
    API_URL: z.url('API_URL must be a valid URL'),
    // Required bot token
    BOT_TOKEN: z.string().min(1, 'Bot token is required'),
    COMMAND_LOGGING_CHANNEL: z.string().optional(),

    // Logging settings
    ENABLE_LOGGING: z.string().optional().default('false').transform(stringToBoolean),
    ERROR_LOGGING_CHANNEL: z.string().optional(),

    // Optional comma-separated guild IDs (undefined = global, string[] = guild-specific)
    GUILDS: z
        .string()
        .optional()
        .transform((val) => (val ? stringToArray(val) : undefined)),

    // Maximum subscriptions per user (0 = unlimited)
    MAX_SUBSCRIPTIONS_PER_USER: z
        .string()
        .optional()
        .default('5')
        .transform((val) => {
            const num = Number.parseInt(val, 10);
            return Number.isNaN(num) ? 5 : num;
        }),

    // Polling fallback settings
    POLLING_ENABLED: z.string().optional().default('false').transform(stringToBoolean),
    POLLING_INTERVAL_SECONDS: z
        .string()
        .optional()
        .default('60')
        .transform((val) => {
            const num = Number.parseInt(val, 10);
            return Number.isNaN(num) ? 60 : Math.max(10, num);
        }),
});

// Parse config with error handling
let config: z.infer<typeof configSchema>;
try {
    config = configSchema.parse(process.env);

    // Validate logging channels required when logging is enabled
    if (config.ENABLE_LOGGING && !config.ERROR_LOGGING_CHANNEL && !config.COMMAND_LOGGING_CHANNEL) {
        log.warn(
            'ENABLE_LOGGING is true but ERROR_LOGGING_CHANNEL and COMMAND_LOGGING_CHANNEL are missing. Logging will be disabled.'
        );
        config.ENABLE_LOGGING = false;
    }
} catch (error) {
    if (error instanceof z.ZodError) {
        const missingVars = error.issues
            .map((issue) => `${String(issue.path[0])}: ${issue.message}`)
            .join(', ');

        throw new Error(`Configuration validation failed: ${missingVars}`, { cause: error });
    }
    throw error;
}

export { config };

// Derived polling cap to ensure API safety (30 req/min)
export const POLLING_MAX_PER_TICK = (() => {
    const SAFE_REQUESTS_PER_MINUTE = 30;

    if (!config.POLLING_ENABLED) {
        return { intervalSeconds: 0, maxPerTick: 0 };
    }

    const baseInterval = config.POLLING_INTERVAL_SECONDS;

    // Given a fixed API budget, compute how many queries we can safely poll per tick
    // Budget per tick = SAFE_REQUESTS_PER_MINUTE * (baseInterval / 60)
    const maxPerTick = Math.max(1, Math.floor((SAFE_REQUESTS_PER_MINUTE * baseInterval) / 60));

    return {
        intervalSeconds: baseInterval,
        maxPerTick,
    };
})();
