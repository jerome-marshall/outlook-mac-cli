/**
 * `olk cal` — calendar operations.
 */

import { Command } from 'commander';

import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { CreateEventInput, type ListEventsParams, type SearchEventsParams } from '../../tools/calendar.js';
import type { CalendarWriterParams, RecurrenceConfig, EventUpdates } from '../../applescript/index.js';
import { parseNonNegativeInt, parsePositiveInt, resolveBody } from '../argv.js';
import { emitError, emitSuccess, type OutputOptions } from '../output.js';
import type { Runtime } from '../runtime.js';

export function buildCalCommand(runtime: Runtime, getOutput: () => OutputOptions): Command {
    const cmd = new Command('cal').description('Read, search, and manage Outlook calendar events.');

    cmd.command('calendars')
        .description('List all calendar folders.')
        .action(() => {
            try {
                const items = runtime.tools().calendar.listCalendars({});
                emitSuccess({ items, count: items.length, hasMore: false }, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('list')
        .description('List events, optionally bounded by a date range or limited to one calendar.')
        .option('-c, --calendar <id>', 'Calendar id to filter by', (v) => parsePositiveInt(v, '--calendar'))
        .option('--start <iso>', 'Start of date range (ISO 8601)')
        .option('--end <iso>', 'End of date range (ISO 8601)')
        .option('--days <n>', 'Convenience: list events from now through N days ahead', (v) => parsePositiveInt(v, '--days'))
        .option('--limit <n>', 'Maximum events to return (1-100)', (v) => parsePositiveInt(v, '--limit'), 25)
        .option('--offset <n>', 'Pagination offset', (v) => parseNonNegativeInt(v, '--offset'), 0)
        .action((opts: { calendar?: number; start?: string; end?: string; days?: number; limit: number; offset: number }) => {
            try {
                let start = opts.start;
                let end = opts.end;
                if (opts.days != null) {
                    const now = new Date();
                    const future = new Date(now.getTime() + opts.days * 24 * 60 * 60 * 1000);
                    start = start ?? now.toISOString();
                    end = end ?? future.toISOString();
                }
                const params: ListEventsParams = {
                    limit: opts.limit,
                    offset: opts.offset,
                    ...(opts.calendar != null && { calendar_id: opts.calendar }),
                    ...(start != null && { start_date: start }),
                    ...(end != null && { end_date: end }),
                };
                const result = runtime.tools().calendar.listEvents(params);
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('get <eventId>')
        .description('Get full details of an event including attendees.')
        .action((eventId: string) => {
            try {
                const event = runtime.tools().calendar.getEvent({ event_id: parsePositiveInt(eventId, 'event-id') });
                if (event == null) {
                    throw new NotFoundError('Event', parsePositiveInt(eventId, 'event-id'));
                }
                emitSuccess(event, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('search <query>')
        .description('Search events by title.')
        .option('--limit <n>', 'Maximum results (1-100)', (v) => parsePositiveInt(v, '--limit'), 25)
        .option('--offset <n>', 'Pagination offset', (v) => parseNonNegativeInt(v, '--offset'), 0)
        .option('--after <iso>', 'Only events starting on or after this ISO 8601 date')
        .option('--before <iso>', 'Only events starting on or before this ISO 8601 date')
        .action((query: string, opts: { limit: number; offset: number; after?: string; before?: string }) => {
            try {
                const params: SearchEventsParams = {
                    query,
                    limit: opts.limit,
                    offset: opts.offset,
                    ...(opts.after != null && { after: opts.after }),
                    ...(opts.before != null && { before: opts.before }),
                };
                const result = runtime.tools().calendar.searchEvents(params);
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('create')
        .description('Create a new calendar event.')
        .requiredOption('--subject <text>', 'Event title')
        .requiredOption('--start <iso>', 'Start date in ISO 8601')
        .requiredOption('--end <iso>', 'End date in ISO 8601')
        .option('--calendar <id>', 'Calendar id (default calendar if omitted)', (v) => parsePositiveInt(v, '--calendar'))
        .option('--location <text>', 'Event location')
        .option('--description <text>', 'Description (use --description-file for newline-heavy content)')
        .option('--description-file <path>', 'Read description from file (or "-" for stdin)')
        .option('--all-day', 'Treat as an all-day event', false)
        .action((opts: {
            subject: string;
            start: string;
            end: string;
            calendar?: number;
            location?: string;
            description?: string;
            descriptionFile?: string;
            allDay: boolean;
        }) => {
            try {
                const description = opts.description ?? (opts.descriptionFile != null
                    ? resolveBody(undefined, opts.descriptionFile, 'description')
                    : undefined);
                const validated = CreateEventInput.parse({
                    title: opts.subject,
                    start_date: opts.start,
                    end_date: opts.end,
                    is_all_day: opts.allDay,
                    ...(opts.calendar != null && { calendar_id: opts.calendar }),
                    ...(opts.location != null && { location: opts.location }),
                    ...(description != null && { description }),
                });
                const writerParams = buildCalendarWriterParams(validated);
                const created = runtime.tools().calendarWriter.createEvent(writerParams);
                emitSuccess({
                    id: created.id,
                    title: validated.title,
                    start_date: validated.start_date,
                    end_date: validated.end_date,
                    calendar_id: created.calendarId,
                    location: validated.location ?? null,
                    description: validated.description ?? null,
                    is_all_day: validated.is_all_day,
                    is_recurring: validated.recurrence != null,
                }, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('update <eventId>')
        .description('Update fields on a calendar event.')
        .option('--apply-to <scope>', 'For recurring events: this_instance | all_in_series', 'this_instance')
        .option('--title <text>', 'New title')
        .option('--start <iso>', 'New start date')
        .option('--end <iso>', 'New end date')
        .option('--location <text>', 'New location')
        .option('--description <text>', 'New description')
        .option('--all-day', 'Mark as all-day', false)
        .action((eventId: string, opts: {
            applyTo: string;
            title?: string;
            start?: string;
            end?: string;
            location?: string;
            description?: string;
            allDay: boolean;
        }) => {
            try {
                if (opts.applyTo !== 'this_instance' && opts.applyTo !== 'all_in_series') {
                    throw new ValidationError(`--apply-to must be 'this_instance' or 'all_in_series'`);
                }
                if (opts.start != null && opts.end != null && new Date(opts.start).getTime() >= new Date(opts.end).getTime()) {
                    throw new ValidationError('--start must be before --end');
                }
                const updates: EventUpdates = {
                    ...(opts.title != null && { title: opts.title }),
                    ...(opts.start != null && { startDate: opts.start }),
                    ...(opts.end != null && { endDate: opts.end }),
                    ...(opts.location != null && { location: opts.location }),
                    ...(opts.description != null && { description: opts.description }),
                    ...(opts.allDay && { isAllDay: true }),
                };
                const result = runtime.tools().calendarManager.updateEvent(
                    parsePositiveInt(eventId, 'event-id'),
                    updates,
                    opts.applyTo,
                );
                emitSuccess({ id: result.id, updatedFields: result.updatedFields }, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('delete <eventId>')
        .description('Delete a calendar event.')
        .option('--apply-to <scope>', 'For recurring events: this_instance | all_in_series', 'this_instance')
        .action((eventId: string, opts: { applyTo: string }) => {
            try {
                if (opts.applyTo !== 'this_instance' && opts.applyTo !== 'all_in_series') {
                    throw new ValidationError(`--apply-to must be 'this_instance' or 'all_in_series'`);
                }
                runtime.tools().calendarManager.deleteEvent(
                    parsePositiveInt(eventId, 'event-id'),
                    opts.applyTo,
                );
                emitSuccess({ success: true, eventId: parsePositiveInt(eventId, 'event-id') }, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    cmd.command('respond <eventId>')
        .description('Send an RSVP for a calendar invitation.')
        .requiredOption('--status <state>', 'accept | decline | tentative')
        .option('--comment <text>', 'Optional message to include with the RSVP')
        .option('--no-send-response', 'Suppress the response email to the organizer')
        .action((eventId: string, opts: { status: string; comment?: string; sendResponse: boolean }) => {
            try {
                if (opts.status !== 'accept' && opts.status !== 'decline' && opts.status !== 'tentative') {
                    throw new ValidationError('--status must be accept, decline, or tentative');
                }
                const result = runtime.tools().calendarManager.respondToEvent(
                    parsePositiveInt(eventId, 'event-id'),
                    opts.status,
                    opts.sendResponse,
                    opts.comment,
                );
                emitSuccess(result, getOutput());
            }
            catch (err) {
                process.exit(emitError(err, getOutput()));
            }
        });

    return cmd;
}

/** Maps validated CreateEvent input to the AppleScript writer's param shape. */
function buildCalendarWriterParams(params: ReturnType<typeof CreateEventInput.parse>): CalendarWriterParams {
    let recurrence: RecurrenceConfig | undefined;
    if (params.recurrence != null) {
        const rec = params.recurrence;
        recurrence = {
            frequency: rec.frequency,
            interval: rec.interval,
            ...(rec.days_of_week != null && { daysOfWeek: rec.days_of_week }),
            ...(rec.day_of_month != null && { dayOfMonth: rec.day_of_month }),
            ...(rec.week_of_month != null && { weekOfMonth: rec.week_of_month }),
            ...(rec.day_of_week_monthly != null && { dayOfWeekMonthly: rec.day_of_week_monthly }),
            ...(rec.end.type === 'end_date' && { endDate: rec.end.date }),
            ...(rec.end.type === 'end_after_count' && { endAfterCount: rec.end.count }),
        };
    }
    return {
        title: params.title,
        startDate: params.start_date,
        endDate: params.end_date,
        ...(params.calendar_id != null && { calendarId: params.calendar_id }),
        ...(params.location != null && { location: params.location }),
        ...(params.description != null && { description: params.description }),
        ...(params.is_all_day != null && { isAllDay: params.is_all_day }),
        ...(recurrence != null && { recurrence }),
    };
}
