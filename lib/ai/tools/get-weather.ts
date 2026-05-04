import { z } from "zod"

export interface Tool {
  description: string
  parameters: z.ZodSchema
  execute: (args: any) => Promise<any>
}

export function createTool(config: Tool): Tool {
  return config
}

export const getWeather = createTool({
  description: "Get the current weather at a location",
  parameters: z.object({
    latitude: z.number(),
    longitude: z.number(),
  }),
  execute: async ({ latitude, longitude }) => {
    const response = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m&hourly=temperature_2m&daily=sunrise,sunset&timezone=auto`,
    )

    const weatherData = await response.json()
    return weatherData
  },
})
