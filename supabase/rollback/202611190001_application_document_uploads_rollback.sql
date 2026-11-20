-- Undo 202611190001_application_document_uploads.sql.
-- Run only if the upload feature must be removed. Files already in the bucket are NOT
-- deleted by this script: empty the "application-documents" bucket in the Supabase
-- dashboard first if they should be removed (they are personal data).
begin;

drop function if exists public.record_document_access(text, bigint);
drop policy if exists "Registrar reads application documents" on storage.objects;

-- Restore the PB-09 version of the Registrar detail function.
create or replace function public.get_registrar_application(p_reference text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
    result jsonb;
begin
    perform public.require_registrar();
    select (to_jsonb(a) - 'submitter_ip_hash' - 'period_id') || jsonb_build_object(
        'school_year', p.school_year,
        'guardians', coalesce((select jsonb_agg(jsonb_build_object(
                'relationship', g.relationship, 'full_name', g.full_name,
                'occupation', g.occupation, 'contact_number', g.contact_number) order by g.relationship)
            from public.application_guardians g where g.application_id = a.id), '[]'::jsonb),
        'documents', coalesce((select jsonb_agg(jsonb_build_object(
                'id', d.id, 'document_type', d.document_type, 'uploaded_at', d.uploaded_at) order by d.uploaded_at)
            from public.application_documents d where d.application_id = a.id), '[]'::jsonb),
        'requirement_checks', coalesce((select jsonb_object_agg(c.requirement_key, c.received)
            from public.application_requirement_checks c where c.application_id = a.id), '{}'::jsonb))
    into result
    from public.enrollment_applications a
    join public.enrollment_periods p on p.id = a.period_id
    where a.reference_no = p_reference;
    return result;
end;
$$;

drop index if exists public.application_documents_one_per_requirement;
alter table public.application_documents
    drop constraint if exists application_documents_storage_path_format,
    drop constraint if exists application_documents_file_size_range,
    drop constraint if exists application_documents_content_type_allowed,
    drop constraint if exists application_documents_document_type_format,
    drop column if exists file_size_bytes,
    drop column if exists content_type;

-- Keep the bucket (it may still hold files); make sure it stays private.
update storage.buckets set public = false where id = 'application-documents';

commit;
