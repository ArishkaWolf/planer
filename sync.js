import {isCalendarEvent, isTheaterId} from './planner.js'

export function validSchedule(data) {
  return data && Array.isArray(data.events) && data.events.every(isCalendarEvent)
    && [data.hiddenShows,data.importantShows].every(ids => Array.isArray(ids) && ids.every(isTheaterId))
}
