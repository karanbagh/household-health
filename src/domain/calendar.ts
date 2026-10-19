export interface CalendarAppointment {
  id: string; startsAt: Date; memberName: string; providerName: string | null;
  specialty: string | null; location: string | null;
}
const escapeText = (value: string) => value.replace(/\\/g,"\\\\").replace(/\r\n|\r|\n/g,"\\n").replace(/;/g,"\\;").replace(/,/g,"\\,");
const stamp = (date: Date) => date.toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/, "Z");
// RFC 5545 folds at 75 octets, without splitting a UTF-8 code point.
function fold(line: string): string {
  let output="", current="", length=0;
  for(const character of line) {
    const bytes=Buffer.byteLength(character,"utf8");
    if(length+bytes>75) {output+=current+"\r\n";current=" ";length=1;}
    current+=character;length+=bytes;
  }
  return output+current;
}
export function appointmentCalendar(appointment: CalendarAppointment, reminderMinutes: number, durationMinutes: number, now = new Date(), invitation?: { organizer: string; attendee: string }): string {
  const title=`${appointment.memberName} — ${appointment.specialty ?? appointment.providerName ?? "Medical"} appointment`;
  const description=[`Appointment for ${appointment.memberName}.`,appointment.providerName && `Provider: ${appointment.providerName}`,"Imported from Household Health. Changes in the app do not automatically update this calendar event."].filter(Boolean).join("\n");
  const lines=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Household Health//Appointments//EN","CALSCALE:GREGORIAN",invitation?"METHOD:REQUEST":"METHOD:PUBLISH","BEGIN:VEVENT",
    `UID:appointment-${appointment.id}@household-health.local`,`DTSTAMP:${stamp(now)}`,`DTSTART:${stamp(appointment.startsAt)}`,`DTEND:${stamp(new Date(appointment.startsAt.getTime()+durationMinutes*60000))}`,
    `SUMMARY:${escapeText(title)}`,`DESCRIPTION:${escapeText(description)}`,"STATUS:CONFIRMED","TRANSP:OPAQUE"];
  if(appointment.location) lines.push(`LOCATION:${escapeText(appointment.location)}`);
  if(invitation) {
    // Both values come from verified account emails, not free-form calendar input.
    if([invitation.organizer,invitation.attendee].some(value=>/[\r\n:;]/.test(value))) throw new Error("Invalid calendar email");
    lines.push(`ORGANIZER:mailto:${invitation.organizer}`,`ATTENDEE;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:${invitation.attendee}`,"SEQUENCE:0");
  }
  lines.push("BEGIN:VALARM",`TRIGGER:-PT${reminderMinutes}M`,"ACTION:DISPLAY",`DESCRIPTION:${escapeText(title)}`,"END:VALARM","END:VEVENT","END:VCALENDAR");
  return lines.map(fold).join("\r\n")+"\r\n";
}
