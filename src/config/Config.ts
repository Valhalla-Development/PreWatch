import { z } from 'zod';

// Helper transforms for common patterns
const stringToBoolean = (val: string): boolean => val.toLowerCase() === 'true';
const stringToArray = (val: string): string[] => {
    return val
        ? val
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
        : [];
};

const configSchema = z.object({
    // Required bot token
    BOT_TOKEN: z.string().min(1, 'Bot token is required'),

    // Required API URL
    API_URL: z.url('API_URL must be a valid URL'),

    // Maximum subscriptions per user (0 = unlimited)
    MAX_SUBSCRIPTIONS_PER_USER: z
        .string()
        .optional()
        .default('5')
        .transform((val) => {
            const num = Number.parseInt(val, 10);
            return Number.isNaN(num) ? 5 : num;
        }),

    // Environment (defaults to development)
    NODE_ENV: z.enum(['development', 'production']).default('development'),

    // Optional comma-separated guild IDs (undefined = global, string[] = guild-specific)
    GUILDS: z
        .string()
        .optional()
        .transform((val) => (val ? stringToArray(val) : undefined)),

    // Logging settings
    ENABLE_LOGGING: z.string().optional().default('false').transform(stringToBoolean),
    ERROR_LOGGING_CHANNEL: z.string().optional(),
    COMMAND_LOGGING_CHANNEL: z.string().optional(),

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
        console.warn(
            '⚠️  ENABLE_LOGGING is true but ERROR_LOGGING_CHANNEL and COMMAND_LOGGING_CHANNEL are missing. Logging will be disabled.'
        );
        config.ENABLE_LOGGING = false;
    }
} catch (error) {
    if (error instanceof z.ZodError) {
        const missingVars = error.issues
            .map((issue) => `${String(issue.path[0])}: ${issue.message}`)
            .join(', ');

        throw new Error(`Configuration validation failed: ${missingVars}`);
    }
    throw error;
}

export { config };

export const isDev = config.NODE_ENV === 'development';

// Derived polling cap to ensure API safety (30 req/min)
export const POLLING_MAX_PER_TICK = (() => {
    const SAFE_REQUESTS_PER_MINUTE = 30;

    if (!config.POLLING_ENABLED) {
        return { maxPerTick: 0, intervalSeconds: 0 };
    }

    const baseInterval = config.POLLING_INTERVAL_SECONDS;

    // Given a fixed API budget, compute how many queries we can safely poll per tick
    // Budget per tick = SAFE_REQUESTS_PER_MINUTE * (baseInterval / 60)
    const maxPerTick = Math.max(1, Math.floor((SAFE_REQUESTS_PER_MINUTE * baseInterval) / 60));

    return {
        maxPerTick,
        intervalSeconds: baseInterval,
    };
})();
