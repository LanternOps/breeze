import { useCallback } from 'react';
import ReportsList, { type Report } from './ReportsList';

export default function ReportsPage() {
  const handleEdit = useCallback((report: Report) => {
    window.location.href = `/reports/${report.id}/edit`;
  }, []);

  const handleGenerate = useCallback((report: Report) => {
    // Report generation has been triggered
    // The ReportsList component handles the API call
    console.log('Report generation started for:', report.name);
  }, []);

  const handleDelete = useCallback((report: Report) => {
    // Report has been deleted
    console.log('Report deleted:', report.name);
  }, []);

  return (
    <ReportsList
      onEdit={handleEdit}
      onGenerate={handleGenerate}
      onDelete={handleDelete}
    />
  );
}
