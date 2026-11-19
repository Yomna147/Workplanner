<?php

namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;
use Illuminate\Queue\SerializesModels;

class WorkplannerNotificationMail extends Mailable
{
    use Queueable, SerializesModels;

    /**
     * @param  list<array{
     *   rule_label: string,
     *   task_lines: list<array{task_name: string, detail: string}>
     * }>  $sections
     */
    public function __construct(
        public string $projectName,
        public string $partName,
        public array $sections,
    ) {}

    public function envelope(): Envelope
    {
        $count = count($this->sections);
        $subject = $count <= 1
            ? 'Workplanner update — '.$this->projectName
            : "Workplanner updates ({$count}) — {$this->projectName}";

        return new Envelope(subject: $subject);
    }

    public function content(): Content
    {
        return new Content(
            htmlString: $this->buildHtml(),
        );
    }

    private function buildHtml(): string
    {
        $sectionsHtml = collect($this->sections)->map(function (array $section) {
            $items = collect($section['task_lines'] ?? [])
                ->map(fn (array $line) => '<li><strong>'
                    .e($line['task_name'] ?? 'Untitled task')
                    .'</strong> — '
                    .e($line['detail'] ?? '')
                    .'</li>')
                ->implode('');

            return '<div style="margin:0 0 16px">'
                .'<p style="margin:0 0 6px"><strong>'.e($section['rule_label'] ?? 'Update').'</strong></p>'
                .'<ul style="margin:0;padding-left:18px">'.$items.'</ul>'
                .'</div>';
        })->implode('');

        return '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#0f172a;line-height:1.45">'
            .'<p style="margin:0 0 12px">Project: <strong>'.e($this->projectName).'</strong> / '.e($this->partName).'</p>'
            .$sectionsHtml
            .'<p style="color:#64748b;font-size:12px;margin:16px 0 0">Sent from Workplanner 2.0 — one digest for this save</p>'
            .'</div>';
    }
}
